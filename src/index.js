const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { app, helpers } = require("./app");

const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CLIENT_ORIGIN === "*" ? "*" : CLIENT_ORIGIN } });
const id = (prefix = "") => prefix + crypto.randomBytes(12).toString("hex");
const inRoom = (room, userId) => room && room.members.includes(userId);
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
  });
  socket.on("leave_room", ({ roomId }) => {
    if (roomId) socket.leave(roomId);
    if (socket.data.roomId === roomId) socket.data.roomId = null;
  });
  // Accepts an optional ack callback so the client can tell a message was
  // actually persisted and broadcast, rather than assuming success the
  // moment it's emitted (socket.emit does not by itself confirm delivery).
  socket.on("send_message", async ({ roomId, type = "text", text = "", fileName, mimeType, uri, size, url, title, artist, thumbnail }, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    const MUSIC_LINK_PATTERN = /^https?:\/\/(open\.spotify\.com|music\.apple\.com|music\.youtube\.com|soundcloud\.com)\//i;
    try {
      const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
      if (!inRoom(room, socket.user.id)) return ack({ ok: false, error: "You are not a member of this chat." });
      if (type === "text" && !String(text).trim()) return ack({ ok: false, error: "Message is empty." });
      if (type === "music" && !MUSIC_LINK_PATTERN.test(String(url || ""))) return ack({ ok: false, error: "Not a supported music link." });
      const message = { id: id("msg_"), roomId, userId: socket.user.id, userName: socket.user.name, type, text: String(text || "").trim(), fileName: fileName || null, mimeType: mimeType || null, uri: uri || null, size: Number(size) || 0, url: url || null, title: title || null, artist: artist || null, thumbnail: thumbnail || null, createdAt: new Date().toISOString() };
      db.messages.push(message); if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
      await helpers.saveState(db);
      io.to(roomId).emit("new_message", message);
      ack({ ok: true, message });
    } catch (error) {
      console.error(error);
      ack({ ok: false, error: "Server storage is unavailable. Please try again." });
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

server.listen(PORT, "0.0.0.0", () => console.log(`Music Chat backend listening on ${PORT}`));
