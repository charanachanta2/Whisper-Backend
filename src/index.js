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
  // Real audio for voice rooms is now handled entirely by LiveKit (see
  // POST /api/voice/token in app.js) -- LiveKit's own Room object tracks
  // who's actually connected and their live mute state, which is the real
  // thing rather than a self-reported flag. This socket used to maintain a
  // separate, purely cosmetic presence list for voice rooms (voice_join /
  // voice_leave / voice_update); that's been removed since LiveKit's
  // participant data replaces it and keeping both around would just be two
  // sources of truth that could disagree.
});

server.listen(PORT, "0.0.0.0", () => console.log(`Music Chat backend listening on ${PORT}`));

// Render sends SIGTERM before stopping/restarting an instance (deploys,
// free-tier spin-down). The state store debounces its writes to Mongo (see
// store.js), so without this, whatever was saved in the last ~300ms-5s
// before shutdown could be lost. This flushes it first.
async function gracefulShutdown() {
  try { await helpers.shutdown(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
