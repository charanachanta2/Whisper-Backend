const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { promisify } = require("util");
const { AccessToken } = require("livekit-server-sdk");
const { loadState, saveState, shutdown } = require("./store");

const scrypt = promisify(crypto.scrypt);

const app = express();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-me-session-secret";
const INVITE_SECRET = process.env.INVITE_SECRET || "change-me-invite-secret";
// LiveKit Cloud handles the actual real-time audio (WebRTC media + TURN
// relay) for voice rooms -- Render's free tier can't host a TURN server
// itself, since TURN needs raw UDP and Render's free web services only
// accept HTTP(S). This server's only involvement in a voice call is
// /api/voice/token below, which checks the requester is really a member of
// that room and then mints a short-lived, room-scoped token for them.
// LIVEKIT_URL is the wss:// endpoint from your LiveKit Cloud project (or a
// self-hosted LiveKit server elsewhere); LIVEKIT_API_KEY/SECRET are its
// API credentials. Voice chat is disabled with a clear error until all
// three are set -- see server/.env.example.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

// Real attachment storage: uploaded photos, videos and files land here and
// are served back over HTTP so every member of a chat (not just the sender)
// can actually load them. This is a plain-disk store, which is fine for a
// single Render instance but -- as the README's media section notes -- is
// NOT durable across redeploys/restarts. Swap this for S3/R2/Supabase
// Storage before relying on it for anything you can't afford to lose.
const UPLOADS_DIR = path.join(__dirname, "..", "data", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Photos are now compressed/resized on-device before upload (see
// uploadAsset() in mobile/App.js), so they land here well under 1-2MB.
// This limit mainly exists to bound short videos, which still aren't
// re-encoded client-side. 80MB was needlessly generous for a free-tier
// instance with limited RAM: this whole file is briefly held in memory
// twice over (once as the base64 JSON body, once as the decoded Buffer)
// before it ever touches disk, so a single large upload could crowd out
// everything else the process is doing. 40MB is still enough for a
// minute-plus of compressed video.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const ALLOWED_UPLOAD_PREFIXES = ["image/", "video/", "audio/"];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").slice(0, 10);
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    const okType = ALLOWED_UPLOAD_PREFIXES.some(p => (file.mimetype || "").startsWith(p)) || file.mimetype === "application/octet-stream";
    cb(okType ? null : new Error("Unsupported file type."), okType);
  },
});
// Public base URL used to build absolute attachment links (e.g. on Render,
// set PUBLIC_BASE_URL to the same URL as your service). Falls back to
// reading the request's own host, which works for local/dev use too.
function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

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
// /api/upload is deliberately excluded here and given its own, much larger
// limit further down -- a base64-encoded photo/video body can be well over
// this 2mb cap, and Express's body parser enforces whichever limit runs
// first, so leaving that route in this one would reject large uploads
// before they ever reached the route's own parser.
app.use((req, res, next) => {
  if (req.path === "/api/upload") return next();
  express.json({ limit: "2mb" })(req, res, next);
});
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "7d" }));

function id(prefix = "") { return prefix + crypto.randomBytes(12).toString("hex"); }
// scrypt is deliberately slow (that's what makes it a good password hash),
// which is exactly why it must never run via the *Sync variant on a
// single-threaded Node process: crypto.scryptSync blocks the entire event
// loop -- meaning every other connected socket and every other in-flight
// request freezes -- for the ~50-100ms it takes to hash. The async
// crypto.scrypt (used here via promisify) runs on Node's libuv threadpool
// instead, so a login or registration no longer stalls everyone else's
// chat while it computes.
async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { const buf = await scrypt(password, salt, 64); return { salt, hash: buf.toString("hex") }; }
async function verifyPassword(password, user) { const buf = await scrypt(password, user.salt, 64); return buf.toString("hex") === user.passwordHash; }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); return `${body}.${sig}`; }
function verify(token) { if (!token) return null; try { const [body, sig] = token.split("."); const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const data = JSON.parse(Buffer.from(body, "base64url").toString()); return data.exp > Date.now() ? data : null; } catch (_) { return null; } }
function publicUser(user) { return { id: user.id, username: user.username, name: user.name, bio: user.bio || "", avatarUrl: user.avatarUrl || null }; }
// Posts store userName at creation time (so a feed still reads sensibly if
// the author is later removed), but the avatar should always reflect the
// author's *current* profile photo -- otherwise updating your avatar would
// leave every past post showing the old one. This resolves it live from
// the user record on every read instead of caching it on the post.
function postForClient(db, post) {
  const author = db.users.find(u => u.id === post.userId);
  return { ...post, userAvatarUrl: author ? (author.avatarUrl || null) : null };
}
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
    isVoice: Boolean(room.isVoice),
    otherUser: otherUser ? publicUser(otherUser) : null,
    memberCount: room.members.length,
    members: room.members.map(uid => db.users.find(u => u.id === uid)).filter(Boolean).map(publicUser),
    messages: db.messages.filter(m => m.roomId === room.id).slice(-200),
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
    room = { id: id("room_"), name: "Direct messages", directKey: key, members, messages: [], createdAt: new Date().toISOString() };
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
// Lets someone update their own display name, bio, and profile photo.
// Deliberately narrow: only these three fields, and only for req.user --
// there's no userId in the body, so there's no way to target anyone else's
// account through this route.
app.patch("/api/me", auth, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.name !== undefined) req.user.name = String(body.name).trim().slice(0, 60) || req.user.name;
    if (body.bio !== undefined) req.user.bio = String(body.bio).trim().slice(0, 280);
    if (body.avatarUrl !== undefined) req.user.avatarUrl = body.avatarUrl ? String(body.avatarUrl).slice(0, 2000) : null;
    await saveState(req.db);
    res.json({ user: publicUser(req.user) });
  } catch (error) { next(error); }
});

// Uploads a photo, video, or file and returns the URL other members of a
// chat can actually load. This replaces sending the sender's local
// file:// URI as message metadata, which only ever worked on the sender's
// own device.
//
// Accepts two shapes:
//  - application/json: { fileName, mimeType, data: base64 } -- this is what
//    the app itself sends now (see uploadAsset() in mobile/App.js). Kept as
//    plain JSON deliberately, since native multipart/FormData encoding on
//    the client has repeatedly broken across RN/Expo versions.
//  - multipart/form-data with a "file" field -- kept only for backward
//    compatibility with any older client build still out there.
// A larger body-size limit is scoped to just this route (via the
// middleware below) rather than raised globally, since a base64 video can
// be ~1.4x its raw byte size. Sized to MAX_UPLOAD_BYTES's 40MB ceiling with
// that ~1.4x factor plus some headroom for JSON framing/field names.
const uploadJsonLimit = express.json({ limit: "58mb" });
app.post("/api/upload", auth, uploadJsonLimit, async (req, res) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.startsWith("application/json")) {
    try {
      const { fileName, mimeType, data } = req.body || {};
      if (!data) return res.status(400).json({ error: "No file received." });
      const type = mimeType || "application/octet-stream";
      const okType = ALLOWED_UPLOAD_PREFIXES.some(p => type.startsWith(p)) || type === "application/octet-stream";
      if (!okType) return res.status(400).json({ error: "Unsupported file type." });
      const buffer = Buffer.from(data, "base64");
      if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: "That file is too large (max 40MB)." });
      const ext = path.extname(fileName || "").slice(0, 10);
      const filename = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
      // fs.promises.writeFile (not the *Sync version) so this disk write
      // doesn't block the Node event loop -- a writeFileSync here used to
      // freeze every other connected user's chat (messages, voice presence,
      // everything) for however long this one file took to hit disk.
      await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), buffer);
      return res.json({
        url: `${publicBaseUrl(req)}/uploads/${filename}`,
        mimeType: type,
        fileName: fileName || filename,
        size: buffer.length,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "Upload failed." });
    }
  }
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message === "File too large" ? "That file is too large (max 40MB)." : err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No file received." });
    res.json({
      url: `${publicBaseUrl(req)}/uploads/${req.file.filename}`,
      mimeType: req.file.mimetype,
      fileName: req.file.originalname || req.file.filename,
      size: req.file.size,
    });
  });
});

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
    const pass = await hashPassword(String(password));
    const user = { id: id("usr_"), username: normalized, name: String(name || username).trim(), bio: "", avatarUrl: null, salt: pass.salt, passwordHash: pass.hash, active: true, createdAt: new Date().toISOString() };
    db.users.push(user); invite.used = true; invite.usedBy = user.id; invite.usedAt = Date.now();
    await saveState(db);
    res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => { try { const db = await loadState(); const normalized = String(req.body?.username || "").trim().toLowerCase(); const user = db.users.find(u => u.username === normalized); if (!user || !(await verifyPassword(String(req.body?.password || ""), user))) return res.status(401).json({ error: "Invalid username or password." }); res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) }); } catch (error) { next(error); } });
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
        isVoice: Boolean(r.isVoice),
        otherUser: otherUser ? publicUser(otherUser) : null,
        memberCount: r.members.length,
        lastMessage: lastMessage ? { text: lastMessage.text, type: lastMessage.type, createdAt: lastMessage.createdAt, userName: lastMessage.userName } : null,
      };
    })
    .sort((a, b) => (b.lastMessage?.createdAt || "").localeCompare(a.lastMessage?.createdAt || "")),
}));
app.post("/api/rooms", auth, async (req, res, next) => { try { const isVoice = Boolean(req.body?.isVoice); const room = { id: id("room_"), name: String(req.body?.name || (isVoice ? "Voice room" : "Private chat")).trim().slice(0, 80), members: [req.user.id], isVoice, createdAt: new Date().toISOString() }; req.db.rooms.push(room); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });
app.post("/api/rooms/:roomId/invite", auth, async (req, res, next) => { try { const room = req.db.rooms.find(r => r.id === req.params.roomId); if (!room || !room.members.includes(req.user.id)) return res.status(403).json({ error: "Not a member." }); if (room.directKey) return res.status(400).json({ error: "Direct messages can't have people added. Start a room instead." }); const target = req.db.users.find(u => u.username === String(req.body?.username || "").trim().toLowerCase()); if (!target) return res.status(404).json({ error: "User not found." }); if (!room.members.includes(target.id)) room.members.push(target.id); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });

// Mints a LiveKit access token scoped to exactly one voice room, after
// checking the requester is actually a member of it. The token is short
// -lived (10 minutes) since the client only needs it long enough to
// establish the connection; LiveKit keeps the session alive after that
// without needing a fresh token.
app.post("/api/voice/token", auth, async (req, res, next) => {
  try {
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      return res.status(503).json({ error: "Voice chat isn't configured on this server yet." });
    }
    const room = req.db.rooms.find(r => r.id === req.body?.roomId);
    if (!room || !room.isVoice) return res.status(404).json({ error: "Voice room not found." });
    if (!room.members.includes(req.user.id)) return res.status(403).json({ error: "You are not a member of this voice room." });
    // Namespaced so this app's room ids can never collide with anything
    // else in the same LiveKit project.
    const livekitRoomName = `voice-${room.id}`;
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: req.user.id,
      name: req.user.name,
      ttl: "10m",
    });
    at.addGrant({ room: livekitRoomName, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();
    res.json({ token, url: LIVEKIT_URL, roomName: livekitRoomName });
  } catch (error) { next(error); }
});

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
app.get("/api/posts", auth, (req, res) => res.json({ posts: req.db.posts.filter(p => p.userId === req.user.id || connected(req.db, req.user.id, p.userId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(p => postForClient(req.db, p)) }));
app.post("/api/posts", auth, async (req, res, next) => { try { const text = String(req.body?.text || "").trim().slice(0, 2000); const media = req.body?.media || null; if (!text && !media) return res.status(400).json({ error: "Write something or attach a photo." }); const post = { id: id("post_"), userId: req.user.id, userName: req.user.name, text, media, createdAt: new Date().toISOString() }; req.db.posts.push(post); await saveState(req.db); res.json({ post: postForClient(req.db, post) }); } catch (error) { next(error); } });
// Edit/delete are restricted to the post's own author -- checked by
// comparing p.userId to req.user.id before allowing either operation.
app.put("/api/posts/:postId", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found." });
    if (post.userId !== req.user.id) return res.status(403).json({ error: "You can only edit your own posts." });
    const text = String(req.body?.text ?? post.text).trim().slice(0, 2000);
    const media = req.body?.media !== undefined ? req.body.media : post.media;
    if (!text && !media) return res.status(400).json({ error: "Write something or attach a photo." });
    post.text = text; post.media = media; post.editedAt = new Date().toISOString();
    await saveState(req.db);
    res.json({ post: postForClient(req.db, post) });
  } catch (error) { next(error); }
});
app.delete("/api/posts/:postId", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found." });
    if (post.userId !== req.user.id) return res.status(403).json({ error: "You can only delete your own posts." });
    req.db.posts = req.db.posts.filter(p => p.id !== req.params.postId);
    await saveState(req.db);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get("/api/stories", auth, (req, res) => res.json({ stories: req.db.stories.filter(s => s.expiresAt > Date.now() && (s.userId === req.user.id || connected(req.db, req.user.id, s.userId))) }));
app.post("/api/stories", auth, async (req, res, next) => { try { const text = String(req.body?.text || "").trim().slice(0, 500); const media = req.body?.media || null; if (!text && !media) return res.status(400).json({ error: "Add text or a photo." }); const story = { id: id("story_"), userId: req.user.id, userName: req.user.name, text, media, createdAt: new Date().toISOString(), expiresAt: Date.now() + 86400000 }; req.db.stories.push(story); await saveState(req.db); res.json({ story }); } catch (error) { next(error); } });

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: "Server storage is unavailable. Please try again." }); });

module.exports = { app, helpers: { verify, roomForClient, loadState, saveState, shutdown } };
