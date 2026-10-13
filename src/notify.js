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

// --- Persistent notification inbox -------------------------------------
// Every notification is also saved on the server so the in-app bell keeps a
// history (across devices and restarts). Entries with the same `tag` for the
// same person (e.g. several messages in one chat) are merged into one row that
// is bumped to the top and marked unread again, instead of flooding the list.
const MAX_PER_USER = 200;
const MAX_AGE_MS = 60 * 24 * 3600 * 1000;
function newId() { return "ntf_" + require("crypto").randomBytes(10).toString("hex"); }

let lastAgePrune = 0;
async function storeNotifications(entries) {
  const fresh = await loadState();
  fresh.notifications = fresh.notifications || [];
  const now = new Date().toISOString();
  const touched = new Set();
  for (const { userId, payload } of entries) {
    const { room, ...data } = payload;
    touched.add(userId);
    const existing = data.tag ? fresh.notifications.find(x => x.userId === userId && x.tag === data.tag) : null;
    if (existing) {
      Object.assign(existing, data, { read: false, createdAt: now });
      payload.notificationId = existing.id;
    } else {
      const entry = { id: newId(), userId, ...data, read: false, createdAt: now };
      fresh.notifications.push(entry);
      payload.notificationId = entry.id;
    }
  }
  // Cap history only for the people who just got a notification (instead of
  // sorting everyone's notifications every time), and sweep old rows hourly.
  const sweepAge = Date.now() - lastAgePrune > 3600 * 1000;
  if (sweepAge) lastAgePrune = Date.now();
  const cutoff = Date.now() - MAX_AGE_MS;
  const counts = new Map();
  let overCap = false;
  for (const x of fresh.notifications) if (touched.has(x.userId)) { const c = (counts.get(x.userId) || 0) + 1; counts.set(x.userId, c); if (c > MAX_PER_USER) overCap = true; }
  if (overCap || sweepAge) {
    fresh.notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const perUser = new Map();
    fresh.notifications = fresh.notifications.filter(x => {
      if (new Date(x.createdAt).getTime() < cutoff) return false;
      const c = (perUser.get(x.userId) || 0) + 1;
      perUser.set(x.userId, c);
      return c <= MAX_PER_USER;
    });
  }
  await saveState(fresh);
}

// build(userId) returns that person's payload:
// { kind, title, body, tag, roomId?, room? }. `room` is only used in-app.
async function notifyUsers({ io, db, userIds, build }) {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return;
  const payloads = new Map(unique.map(uid => [uid, build(uid)]));
  // Save to each person's notification history first (never blocks delivery if it fails).
  try { await storeNotifications(unique.map(uid => ({ userId: uid, payload: payloads.get(uid) }))); }
  catch (error) { console.error("[notify] could not store history:", error.message); }

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

module.exports = { notifyUsers, newId, previewFor, pushPublicKey: PUBLIC_KEY, isPushEnabled: () => pushEnabled };
