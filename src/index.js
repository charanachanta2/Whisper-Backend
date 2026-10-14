const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { enableCache, flushNow } = require("./store");
// Long-running server: keep app state in memory and write it to MongoDB in batches.
enableCache();
const { app, videos, helpers } = require("./app");
const { notifyUsers, previewFor } = require("./notify");

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const server = http.createServer(app);
const io = new Server(server, { serveClient: false, cors: { origin: CLIENT_ORIGIN === "*" ? "*" : CLIENT_ORIGIN } });
app.locals.io = io;
const id = (prefix = "") => prefix + crypto.randomBytes(12).toString("hex");
const inRoom = (room, userId) => room && room.members.includes(userId);
const EDIT_WINDOW_MS = 5 * 60 * 1000; // messages can be edited for 5 minutes after sending
// Short copy of a message stored inside a reply, so the quote renders without looking the original up.
const replySnapshot = (m) => ({
  id: m.id, userId: m.userId, userName: m.userName, type: m.type,
  text: m.type === "text" ? String(m.text || "").slice(0, 140) : (m.type === "music" ? (m.title || "") : ""),
  mimeType: m.mimeType || null, fileName: m.fileName || null,
});
// Presence for voice rooms: who's currently joined, whether their mic is
// muted, and whether they've flagged themselves as sharing audio. This is
// in-memory only (not persisted) since it's live call state, not chat
// history -- it resets whenever the server restarts, same as who's
// currently "online" would.
const voicePresence = new Map(); // roomId -> Map(userId -> { name, muted, sharingAudio })

function voiceState(roomId) {
  const participants = voicePresence.get(roomId);
  return participants ? Array.from(participants.values()) : [];
}

io.use(async (socket, next) => {
  try {
    const session = helpers.verify(socket.handshake.auth?.token);
    if (!session) return next(new Error("Unauthorized"));
    const db = await helpers.loadState();
    const user = db.users.find(u => u.id === session.userId && u.active !== false);
    if (!user) return next(new Error("User not found"));
    socket.user = user;
    next();
  } catch (_) { next(new Error("Server storage is unavailable")); }
});

io.on("connection", socket => {
  // Personal channel: lets the server tell this person about activity in any
  // chat (new message, friend request) even when they're on another screen.
  socket.join(`user:${socket.user.id}`);
  // The app reports whether it is on screen so we only send OS push when it isn't.
  socket.on("app_visibility", ({ visible } = {}) => { socket.data.visibleAt = visible ? Date.now() : 0; });
  socket.on("join_room", async ({ roomId }) => {
    const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
    if (!inRoom(room, socket.user.id)) return socket.emit("error_message", "You are not a member of this chat.");
    // Support one live socket per user across room switches: leave whatever
    // room this socket was previously in so events don't keep flowing to a
    // screen the person has navigated away from.
    if (socket.data.roomId && socket.data.roomId !== roomId) socket.leave(socket.data.roomId);
    socket.join(roomId); socket.data.roomId = roomId;
    const state = helpers.roomForClient(db, room, socket.user.id);
    socket.emit("room_state", state); io.to(roomId).emit("members_changed", state.members);
    // Opening a chat counts as reading its notification.
    let marked = false;
    for (const n of db.notifications || []) if (n.userId === socket.user.id && n.roomId === roomId && !n.read) { n.read = true; marked = true; }
    if (marked) {
      try { await helpers.saveState(db); }
      catch (error) { console.error("[notify] mark read failed:", error.message); }
    }
  });
  socket.on("leave_room", ({ roomId }) => {
    if (roomId) socket.leave(roomId);
    if (socket.data.roomId === roomId) socket.data.roomId = null;
  });
  // Accepts an optional ack callback so the client can tell a message was
  // actually persisted and broadcast, rather than assuming success the
  // moment it's emitted (socket.emit does not by itself confirm delivery).
  socket.on("send_message", async ({ roomId, type = "text", text = "", fileName, mimeType, uri, size, url, title, artist, thumbnail, thumbUrl, width, height, replyToId }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const MUSIC_LINK_PATTERN = /^https?:\/\/(open\.spotify\.com|music\.apple\.com|music\.youtube\.com|soundcloud\.com)\//i;
    try {
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      if (type === "text" && !String(text).trim()) return ack({ ok: false, error: "Message is empty." });
      if (type === "music" && !MUSIC_LINK_PATTERN.test(String(url || ""))) return ack({ ok: false, error: "Not a supported music link." });
      // Replying: keep a small snapshot of the quoted message so the quote still renders even if the original is far up the history.
      let replyTo = null;
      if (replyToId) {
        const original = db.messages.find(m => m.id === String(replyToId) && m.roomId === roomId);
        if (!original) return ack({ ok: false, error: "The message you're replying to no longer exists." });
        replyTo = replySnapshot(original);
      }
      const message = { id: id("msg_"), roomId, userId: socket.user.id, userName: socket.user.name, type, text: String(text || "").trim(), fileName: fileName || null, mimeType: mimeType || null, uri: uri || null, size: Number(size) || 0, url: url || null, title: title || null, artist: artist || null, thumbnail: thumbnail || null, thumbUrl: typeof thumbUrl === "string" ? thumbUrl : null, width: Number(width) || null, height: Number(height) || null, replyTo, reactions: [], createdAt: new Date().toISOString() };
      // A deleted chat (hidden for someone) reappears in their list as soon as there's a new message.
      if (room.hidden) room.hidden = {};
      db.messages.push(message); if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
      await helpers.saveState(db);
      io.to(roomId).emit("new_message", message);
      ack({ ok: true, message });
      const recipients = room.members.filter(uid => uid !== socket.user.id);
      if (recipients.length) {
        const isDirect = Boolean(room.directKey);
        const preview = previewFor(message);
        notifyUsers({ io, db, userIds: recipients, build: uid => {
          const { messages, members, ...lite } = helpers.roomForClient(db, room, uid, { withMessages: false });
          return { kind: "message", roomId, room: lite, title: isDirect ? socket.user.name : (room.name || "New message"), body: isDirect ? preview : `${socket.user.name}: ${preview}`, tag: `room-${roomId}` };
        } }).catch(error => console.error("[notify]", error.message));
      }
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Server storage is unavailable. Please try again." });
    }
  });
  // --- Delete / react ---
  // Delete for everyone. Only the sender can delete their own message.
  socket.on("delete_message", async ({ roomId, messageId } = {}, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      const index = db.messages.findIndex(m => m.id === String(messageId) && m.roomId === roomId);
      if (index === -1) return ack({ ok: false, error: "Message not found." });
      const message = db.messages[index];
      if (message.userId !== socket.user.id) return ack({ ok: false, error: "You can only delete your own messages." });
      db.messages.splice(index, 1);
      // Messages that quoted it keep working, but no longer reveal what it said.
      const touched = [];
      for (const m of db.messages) {
        if (m.roomId === roomId && m.replyTo && m.replyTo.id === message.id) {
          m.replyTo = { id: message.id, userId: message.userId, userName: message.userName, type: "deleted", text: "" };
          touched.push(m.id);
        }
      }
      await helpers.saveState(db);
      // Remove any photo/video/file from R2 as well (only files inside the sender's own folder).
      if (message.uri || message.url) helpers.deleteMedia(socket.user.id, { url: message.uri || message.url, thumbUrl: message.thumbUrl || null });
      io.to(roomId).emit("message_deleted", { roomId, messageId: message.id, repliesUpdated: touched });
      ack({ ok: true, messageId: message.id });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Could not delete the message. Please try again." });
    }
  });
  // Shared chat wallpaper: every member of the chat sees it, and any member can change it.
  // Value: null (default), "color:#rrggbb", or "image:<https url>" (a photo uploaded through /api/upload).
  socket.on("set_chat_background", async ({ roomId, background } = {}, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      let value = null;
      if (background !== null && background !== undefined && background !== "") {
        const raw = String(background).trim();
        if (/^color:#[0-9a-fA-F]{6}$/.test(raw)) value = raw.toLowerCase();
        else if (/^image:https?:\/\/\S{4,600}$/i.test(raw)) value = raw;
        else return ack({ ok: false, error: "That background isn't supported." });
      }
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      room.background = value;
      room.backgroundBy = socket.user.id;
      await helpers.saveState(db);
      io.to(roomId).emit("chat_background", { roomId, background: value, by: socket.user.id, byName: socket.user.name });
      ack({ ok: true, background: value });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Could not change the background. Please try again." });
    }
  });
  // Delete several of your own messages at once (multi-select). Emits one `message_deleted` per message,
  // so clients need no new handler. Ack: { ok, deleted: [ids], skipped: [ids] }.
  socket.on("delete_messages", async ({ roomId, messageIds } = {}, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      if (!Array.isArray(messageIds) || !messageIds.length) return ack({ ok: false, error: "Nothing selected." });
      const wanted = new Set(messageIds.slice(0, 100).map(String));
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      const removed = [];
      db.messages = db.messages.filter(m => {
        if (m.roomId === roomId && wanted.has(m.id) && m.userId === socket.user.id) { removed.push(m); return false; }
        return true;
      });
      const removedIds = new Set(removed.map(m => m.id));
      const touchedBy = new Map(); // deleted id -> [reply ids updated]
      for (const m of db.messages) {
        if (m.roomId === roomId && m.replyTo && removedIds.has(m.replyTo.id)) {
          const orig = removed.find(r => r.id === m.replyTo.id);
          m.replyTo = { id: orig.id, userId: orig.userId, userName: orig.userName, type: "deleted", text: "" };
          if (!touchedBy.has(orig.id)) touchedBy.set(orig.id, []);
          touchedBy.get(orig.id).push(m.id);
        }
      }
      await helpers.saveState(db);
      for (const message of removed) {
        if (message.uri || message.url) helpers.deleteMedia(socket.user.id, { url: message.uri || message.url, thumbUrl: message.thumbUrl || null });
        io.to(roomId).emit("message_deleted", { roomId, messageId: message.id, repliesUpdated: touchedBy.get(message.id) || [] });
      }
      ack({ ok: true, deleted: removed.map(m => m.id), skipped: [...wanted].filter(x => !removedIds.has(x)) });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Could not delete the messages. Please try again." });
    }
  });
  // Edit your own text message, but only within 5 minutes of sending it. After that only delete is possible.
  socket.on("edit_message", async ({ roomId, messageId, text } = {}, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      const next = String(text || "").trim().slice(0, 4000);
      if (!next) return ack({ ok: false, error: "Message can't be empty." });
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      const message = db.messages.find(m => m.id === String(messageId) && m.roomId === roomId);
      if (!message) return ack({ ok: false, error: "Message not found." });
      if (message.userId !== socket.user.id) return ack({ ok: false, error: "You can only edit your own messages." });
      if (message.type !== "text") return ack({ ok: false, error: "Only text messages can be edited." });
      if (Date.now() - new Date(message.createdAt).getTime() > EDIT_WINDOW_MS) return ack({ ok: false, error: "You can only edit a message within 5 minutes of sending it.", expired: true });
      if (next === message.text) return ack({ ok: true, message });
      message.text = next;
      message.editedAt = new Date().toISOString();
      // Keep quotes of this message in sync.
      const repliesUpdated = [];
      for (const m of db.messages) {
        if (m.roomId === roomId && m.replyTo && m.replyTo.id === message.id) { m.replyTo = replySnapshot(message); repliesUpdated.push(m.id); }
      }
      await helpers.saveState(db);
      io.to(roomId).emit("message_edited", { roomId, messageId: message.id, text: message.text, editedAt: message.editedAt, repliesUpdated });
      ack({ ok: true, message });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Could not edit the message. Please try again." });
    }
  });
  // One reaction per person per message (like WhatsApp): tapping a different emoji
  // switches your reaction, tapping the same one again removes it.
  socket.on("react_message", async ({ roomId, messageId, emoji } = {}, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      const value = String(emoji || "").trim();
      if (!value || value.length > 16 || !/\p{Extended_Pictographic}/u.test(value)) return ack({ ok: false, error: "Invalid reaction." });
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      const message = db.messages.find(m => m.id === String(messageId) && m.roomId === roomId);
      if (!message) return ack({ ok: false, error: "Message not found." });
      const reactions = Array.isArray(message.reactions) ? message.reactions : [];
      const mine = reactions.find(r => r.userId === socket.user.id);
      message.reactions = reactions.filter(r => r.userId !== socket.user.id);
      if (!mine || mine.emoji !== value) message.reactions.push({ userId: socket.user.id, userName: socket.user.name, emoji: value });
      await helpers.saveState(db);
      io.to(roomId).emit("message_reaction", { roomId, messageId: message.id, reactions: message.reactions });
      ack({ ok: true, reactions: message.reactions });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Could not save the reaction. Please try again." });
    }
  });
  // --- Voice rooms ---
  // Joining/leaving a voice room is separate from join_room/leave_room
  // (which are for the text-chat socket room a screen is currently
  // looking at) -- a voice room tracks who's actually "in the call" with
  // their mic/sharing state, and that has to survive the person swiping
  // to another tab without hanging up.
  socket.on("voice_join", async ({ roomId }) => {
    const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
    if (!inRoom(room, socket.user.id) || !room.isVoice) return socket.emit("error_message", "You are not a member of this voice room.");
    socket.join(`voice:${roomId}`); socket.data.voiceRoomId = roomId;
    if (!voicePresence.has(roomId)) voicePresence.set(roomId, new Map());
    voicePresence.get(roomId).set(socket.user.id, { userId: socket.user.id, name: socket.user.name, muted: false, sharingAudio: false });
    io.to(`voice:${roomId}`).emit("voice_participants", voiceState(roomId));
  });
  socket.on("voice_leave", ({ roomId }) => {
    if (!roomId) return;
    socket.leave(`voice:${roomId}`);
    if (socket.data.voiceRoomId === roomId) socket.data.voiceRoomId = null;
    const participants = voicePresence.get(roomId);
    if (participants) {
      participants.delete(socket.user.id);
      if (participants.size === 0) voicePresence.delete(roomId);
    }
    io.to(`voice:${roomId}`).emit("voice_participants", voiceState(roomId));
  });
  socket.on("voice_update", ({ roomId, muted, sharingAudio }) => {
    const participants = voicePresence.get(roomId);
    const me = participants?.get(socket.user.id);
    if (!me) return;
    if (typeof muted === "boolean") me.muted = muted;
    if (typeof sharingAudio === "boolean") me.sharingAudio = sharingAudio;
    io.to(`voice:${roomId}`).emit("voice_participants", voiceState(roomId));
  });
  socket.on("disconnect", () => {
    const roomId = socket.data.voiceRoomId;
    if (!roomId) return;
    const participants = voicePresence.get(roomId);
    if (participants) {
      participants.delete(socket.user.id);
      if (participants.size === 0) voicePresence.delete(roomId);
    }
    io.to(`voice:${roomId}`).emit("voice_participants", voiceState(roomId));
  });
});

// Write any batched changes to MongoDB before the process exits (deploys/restarts).
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  try { await flushNow(); } catch (error) { console.error("[shutdown] flush failed:", error.message); }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Music Chat backend listening on ${PORT}`);
  videos.resumePending(); // finish compressing any videos left over from before a restart
  // Expired stories (24h) are removed -- and their files deleted from storage -- every hour, not just when someone posts a new story.
  setInterval(async () => {
    try { const db = await helpers.loadState(); if (helpers.purgeExpiredStories(db)) await helpers.saveState(db); }
    catch (error) { console.error("[stories] cleanup failed:", error.message); }
  }, 60 * 60 * 1000).unref();
});
