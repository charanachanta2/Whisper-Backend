const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { loadState, saveState } = require("./store");

const app = express();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-me-session-secret";
const INVITE_SECRET = process.env.INVITE_SECRET || "change-me-invite-secret";

// Single deployment: this process serves both the REST API and the
// Socket.IO realtime connection, and both are signed/verified with this one
// SESSION_SECRET. (Earlier this app supported splitting REST and sockets
// across two separate deployments -- that mode is no longer used, since any
// drift between the two secrets caused logins to "succeed" over REST and
// then get silently rejected the moment a chat opened.)
if (SESSION_SECRET === "change-me-session-secret") {
  console.warn("[config] ADMIN_SESSION_SECRET is unset (using an insecure default). Set a real value in production -- this signs every login token.");
}
if (INVITE_SECRET === "change-me-invite-secret") {
  console.warn("[config] INVITE_SECRET is unset (using an insecure default). Set a real value in production.");
}

app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

function id(prefix = "") { return prefix + crypto.randomBytes(12).toString("hex"); }
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") }; }
function verifyPassword(password, user) { return crypto.scryptSync(password, user.salt, 64).toString("hex") === user.passwordHash; }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); return `${body}.${sig}`; }
function verify(token) { if (!token) return null; try { const [body, sig] = token.split("."); const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const data = JSON.parse(Buffer.from(body, "base64url").toString()); return data.exp > Date.now() ? data : null; } catch (_) { return null; } }
function publicUser(user) { return { id: user.id, username: user.username, name: user.name }; }
// `viewerId` lets us resolve a friendlier name/avatar for 1:1 rooms: instead
// of the generic "Direct messages" label, the client can show the other
// person's name.
function roomForClient(db, room, viewerId) {
  const isDirect = Boolean(room.directKey);
  const otherUserId = isDirect ? room.members.find(uid => uid !== viewerId) : null;
  const otherUser = otherUserId ? db.users.find(u => u.id === otherUserId) : null;
  return {
    id: room.id,
    name: room.name,
    isDirect,
    otherUser: otherUser ? publicUser(otherUser) : null,
    memberCount: room.members.length,
    members: room.members.map(uid => db.users.find(u => u.id === uid)).filter(Boolean).map(publicUser),
    messages: db.messages.filter(m => m.roomId === room.id).slice(-200),
    playback: room.playback,
  };
}
// Shared by the friend-request-accept flow and the "message this friend"
// flow so both always resolve to the same 1:1 room instead of creating
// duplicates.
function getOrCreateDirectRoom(db, firstId, secondId) {
  const members = [firstId, secondId].sort();
  const key = members.join(":");
  let room = db.rooms.find(r => r.directKey === key);
  if (!room) {
    room = { id: id("room_"), name: "Direct messages", directKey: key, members, messages: [], playback: { trackId: null, title: "Nothing playing", artist: "", url: "", position: 0, isPlaying: false, updatedBy: null, updatedAt: Date.now() }, createdAt: new Date().toISOString() };
    db.rooms.push(room);
  }
  return room;
}

async function auth(req, res, next) {
  try {
    const session = verify((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    const db = await loadState();
    const user = db.users.find(u => u.id === session.userId && u.active !== false);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.db = db;
    req.user = user;
    next();
  } catch (error) { next(error); }
}

app.get("/", (req, res) => res.json({ service: "music-chat-api", status: "online" }));
app.get("/health", async (req, res, next) => { try { await loadState(); res.json({ ok: true, service: "music-chat-server", storage: "mongodb" }); } catch (error) { next(error); } });
app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const { username, password, name, inviteCode } = req.body || {};
    if (!username || !password || !inviteCode) return res.status(400).json({ error: "Username, password and invitation code are required." });
    if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const db = await loadState();
    const normalized = String(username).trim().toLowerCase();
    if (db.users.some(u => u.username === normalized)) return res.status(409).json({ error: "Username already exists." });
    const inviteHash = crypto.createHmac("sha256", INVITE_SECRET).update(String(inviteCode).trim()).digest("hex");
    const invite = db.invites.find(i => i.hash === inviteHash && !i.used && (!i.expiresAt || i.expiresAt > Date.now()));
    if (!invite) return res.status(403).json({ error: "Invalid or already used invitation." });
    const pass = hashPassword(String(password));
    const user = { id: id("usr_"), username: normalized, name: String(name || username).trim(), salt: pass.salt, passwordHash: pass.hash, active: true, createdAt: new Date().toISOString() };
    db.users.push(user); invite.used = true; invite.usedBy = user.id; invite.usedAt = Date.now();
    await saveState(db);
    res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => { try { const db = await loadState(); const normalized = String(req.body?.username || "").trim().toLowerCase(); const user = db.users.find(u => u.username === normalized); if (!user || !verifyPassword(String(req.body?.password || ""), user)) return res.status(401).json({ error: "Invalid username or password." }); res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) }); } catch (error) { next(error); } });
app.get("/api/rooms", auth, (req, res) => res.json({
  rooms: req.db.rooms
    .filter(r => r.members.includes(req.user.id))
    .map(r => {
      const isDirect = Boolean(r.directKey);
      const otherUserId = isDirect ? r.members.find(uid => uid !== req.user.id) : null;
      const otherUser = otherUserId ? req.db.users.find(u => u.id === otherUserId) : null;
      const roomMessages = req.db.messages.filter(m => m.roomId === r.id);
      const lastMessage = roomMessages[roomMessages.length - 1] || null;
      return {
        id: r.id,
        name: isDirect && otherUser ? otherUser.name : r.name,
        isDirect,
        otherUser: otherUser ? publicUser(otherUser) : null,
        memberCount: r.members.length,
        lastMessage: lastMessage ? { text: lastMessage.text, type: lastMessage.type, createdAt: lastMessage.createdAt, userName: lastMessage.userName } : null,
      };
    })
    .sort((a, b) => (b.lastMessage?.createdAt || "").localeCompare(a.lastMessage?.createdAt || "")),
}));
app.post("/api/rooms", auth, async (req, res, next) => { try { const room = { id: id("room_"), name: String(req.body?.name || "Private chat").trim().slice(0, 80), members: [req.user.id], playback: { trackId: null, title: "Nothing playing", artist: "", url: "", position: 0, isPlaying: false, updatedBy: null, updatedAt: Date.now() }, createdAt: new Date().toISOString() }; req.db.rooms.push(room); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });
app.post("/api/rooms/:roomId/invite", auth, async (req, res, next) => { try { const room = req.db.rooms.find(r => r.id === req.params.roomId); if (!room || !room.members.includes(req.user.id)) return res.status(403).json({ error: "Not a member." }); if (room.directKey) return res.status(400).json({ error: "Direct messages can't have people added. Start a room instead." }); const target = req.db.users.find(u => u.username === String(req.body?.username || "").trim().toLowerCase()); if (!target) return res.status(404).json({ error: "User not found." }); if (!room.members.includes(target.id)) room.members.push(target.id); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });

function connected(db, firstId, secondId) { return db.friendRequests.some(r => r.status === "accepted" && ((r.fromUserId === firstId && r.toUserId === secondId) || (r.fromUserId === secondId && r.toUserId === firstId))); }
function socialUser(user) { return { id: user.id, username: user.username, name: user.name }; }

// Opens (or creates) the 1:1 chat with an existing friend. This is what
// lets someone message a friend directly from search/discover instead of
// only ever landing in a DM by accepting a fresh request.
app.post("/api/dm/:userId", auth, async (req, res, next) => {
  try {
    const target = req.db.users.find(u => u.id === req.params.userId);
    if (!target || target.id === req.user.id) return res.status(404).json({ error: "User not found." });
    if (!connected(req.db, req.user.id, target.id)) return res.status(403).json({ error: "You need to be friends before you can message them." });
    const room = getOrCreateDirectRoom(req.db, req.user.id, target.id);
    await saveState(req.db);
    res.json({ room: roomForClient(req.db, room, req.user.id) });
  } catch (error) { next(error); }
});

app.get("/api/users/search", auth, (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  if (!query) return res.json({ users: [] });
  const users = req.db.users.filter(u => u.id !== req.user.id && (u.username.includes(query) || u.name.toLowerCase().includes(query))).slice(0, 20).map(u => ({ ...socialUser(u), connected: connected(req.db, req.user.id, u.id) }));
  res.json({ users });
});
app.get("/api/friends/requests", auth, (req, res) => res.json({ incoming: req.db.friendRequests.filter(r => r.toUserId === req.user.id && r.status === "pending").map(r => ({ ...r, from: socialUser(req.db.users.find(u => u.id === r.fromUserId)) })), outgoing: req.db.friendRequests.filter(r => r.fromUserId === req.user.id && r.status === "pending") }));
app.post("/api/friends/requests", auth, async (req, res, next) => { try { const username = String(req.body?.username || "").trim().toLowerCase(); const userId = String(req.body?.userId || "").trim(); const target = req.db.users.find(u => u.id === userId) || req.db.users.find(u => u.username === username); if (!target || target.id === req.user.id) return res.status(404).json({ error: "User not found." }); if (connected(req.db, req.user.id, target.id) || req.db.friendRequests.some(r => r.status === "pending" && ((r.fromUserId === req.user.id && r.toUserId === target.id) || (r.fromUserId === target.id && r.toUserId === req.user.id)))) return res.status(409).json({ error: "A request already exists." }); const request = { id: id("req_"), fromUserId: req.user.id, toUserId: target.id, status: "pending", createdAt: new Date().toISOString() }; req.db.friendRequests.push(request); await saveState(req.db); res.json({ request }); } catch (error) { next(error); } });
app.post("/api/friends/requests/:requestId/accept", auth, async (req, res, next) => { try { const request = req.db.friendRequests.find(r => r.id === req.params.requestId && r.toUserId === req.user.id && r.status === "pending"); if (!request) return res.status(404).json({ error: "Request not found." }); request.status = "accepted"; request.acceptedAt = new Date().toISOString(); const room = getOrCreateDirectRoom(req.db, request.fromUserId, request.toUserId); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });
app.get("/api/posts", auth, (req, res) => res.json({ posts: req.db.posts.filter(p => p.userId === req.user.id || connected(req.db, req.user.id, p.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) }));
app.post("/api/posts", auth, async (req, res, next) => { try { const text = String(req.body?.text || "").trim().slice(0, 2000); const media = req.body?.media || null; if (!text && !media) return res.status(400).json({ error: "Write something or attach a photo." }); const post = { id: id("post_"), userId: req.user.id, userName: req.user.name, text, media, createdAt: new Date().toISOString() }; req.db.posts.push(post); await saveState(req.db); res.json({ post }); } catch (error) { next(error); } });
app.get("/api/stories", auth, (req, res) => res.json({ stories: req.db.stories.filter(s => s.expiresAt > Date.now() && (s.userId === req.user.id || connected(req.db, req.user.id, s.userId))) }));
app.post("/api/stories", auth, async (req, res, next) => { try { const text = String(req.body?.text || "").trim().slice(0, 500); const media = req.body?.media || null; if (!text && !media) return res.status(400).json({ error: "Add text or a photo." }); const story = { id: id("story_"), userId: req.user.id, userName: req.user.name, text, media, createdAt: new Date().toISOString(), expiresAt: Date.now() + 86400000 }; req.db.stories.push(story); await saveState(req.db); res.json({ story }); } catch (error) { next(error); } });

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: "Server storage is unavailable. Please try again." }); });

module.exports = { app, helpers: { verify, roomForClient, loadState, saveState } };
