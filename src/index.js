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
  socket.on("send_message", async ({ roomId, type = "text", text = "", fileName, mimeType, uri, size, url, title }) => {
    const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
    if (!inRoom(room, socket.user.id) || (type === "text" && !String(text).trim()) || (type === "music" && !/^https?:\/\/(open\.)?spotify\.com\//i.test(String(url || "")))) return;
    const message = { id: id("msg_"), roomId, userId: socket.user.id, userName: socket.user.name, type, text: String(text || "").trim(), fileName: fileName || null, mimeType: mimeType || null, uri: uri || null, size: Number(size) || 0, url: url || null, title: title || null, createdAt: new Date().toISOString() };
    db.messages.push(message); if (db.messages.length > 5000) db.messages.splice(0, db.messages.length - 5000);
    await helpers.saveState(db); io.to(roomId).emit("new_message", message);
  });
  socket.on("playback_update", async ({ roomId, playback }) => {
    const db = await helpers.loadState(); const room = db.rooms.find(r => r.id === roomId);
    if (!inRoom(room, socket.user.id) || !playback) return;
    room.playback = { trackId: playback.trackId || null, title: playback.title || "Shared music", artist: playback.artist || "", url: playback.url || "", position: Number(playback.position) || 0, isPlaying: Boolean(playback.isPlaying), updatedBy: socket.user.name, updatedAt: Date.now() };
    await helpers.saveState(db); io.to(roomId).emit("playback_changed", room.playback);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Music Chat backend listening on ${PORT}`));
