// Notifications: (1) a live "notification" socket event, used by the app to show
// an in-app pop-up banner, and (2) optional OS-level web push (iPhone home-screen
// app / desktop browsers) for people who aren't looking at the app right now.
// Web push only turns on when VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.
const { loadState, saveState } = require("./store");

let webpush = null;
try { webpush = require("web-push"); } catch (_) { /* dependency missing */ }

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
let pushEnabled = Boolean(webpush && PUBLIC_KEY && PRIVATE_KEY);
if (pushEnabled) {
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", PUBLIC_KEY, PRIVATE_KEY);
  } catch (error) {
    console.error("[push] Invalid VAPID keys, push disabled:", error.message);
    pushEnabled = false;
  }
} else {
  console.warn("[push] VAPID keys not set: OS push notifications are off (in-app pop-ups still work).");
}

// The app heartbeats "app_visibility" every few seconds while it is on screen.
// If a person's app is actively visible they already get the in-app banner, so
// we skip the OS push for them (this also avoids double alerts).
const ACTIVE_WINDOW_MS = 10000;
async function userIsActive(io, userId) {
  if (!io) return false;
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    return sockets.some(s => s.data.visibleAt && Date.now() - s.data.visibleAt < ACTIVE_WINDOW_MS);
  } catch (_) { return false; }
}

// build(userId) returns that person's payload:
// { kind, title, body, tag, roomId?, room? }. `room` is only used in-app.
async function notifyUsers({ io, db, userIds, build }) {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return;
  const payloads = new Map(unique.map(uid => [uid, build(uid)]));

  for (const uid of unique) {
    if (io) io.to(`user:${uid}`).emit("notification", payloads.get(uid));
  }

  if (!pushEnabled) return;
  const subs = (db.pushSubscriptions || []).filter(s => payloads.has(s.userId));
  if (!subs.length) return;

  const inactive = new Set();
  for (const uid of new Set(subs.map(s => s.userId))) {
    if (!(await userIsActive(io, uid))) inactive.add(uid);
  }

  const dead = [];
  await Promise.all(subs.filter(s => inactive.has(s.userId)).map(async sub => {
    const { room, ...slim } = payloads.get(sub.userId);
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(slim),
        { TTL: 86400, urgency: "high" },
      );
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) dead.push(sub.endpoint);
      else console.error("[push] send failed:", error.statusCode || error.message);
    }
  }));

  if (dead.length) {
    try {
      const fresh = await loadState();
      fresh.pushSubscriptions = (fresh.pushSubscriptions || []).filter(s => !dead.includes(s.endpoint));
      await saveState(fresh);
    } catch (error) { console.error("[push] cleanup failed:", error.message); }
  }
}

function previewFor(message) {
  if (message.type === "music") return `🎵 ${message.title || "Shared a song"}`;
  if (message.type === "text") return String(message.text || "").slice(0, 140);
  const mime = message.mimeType || "";
  if (mime.startsWith("image/")) return "📷 Photo";
  if (mime.startsWith("video/")) return "🎬 Video";
  if (mime.startsWith("audio/")) return "🎧 Audio";
  return `📎 ${message.fileName || "File"}`;
}

module.exports = { notifyUsers, previewFor, pushPublicKey: PUBLIC_KEY, isPushEnabled: () => pushEnabled };
