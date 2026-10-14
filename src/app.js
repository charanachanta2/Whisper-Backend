const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const compression = require("compression");
const { loadState, saveState, avatarsCollection, findInvite, consumeInvite } = require("./store");
const { notifyUsers, pushPublicKey, isPushEnabled } = require("./notify");
const { Binary } = require("mongodb");
const storage = require("./storage");
const { optimizeImage, optimizeAvatar, makeAvatarThumb, createVideoCompressor, extFor } = require("./media");

const app = express();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-me-session-secret";
const INVITE_SECRET = process.env.INVITE_SECRET || "change-me-invite-secret";

// Real attachment storage: uploaded photos, videos and files land here and
// are served back over HTTP so every member of a chat (not just the sender)
// can actually load them. This is a plain-disk store, which is fine for a
// single Render instance but -- as the README's media section notes -- is
// NOT durable across redeploys/restarts. Swap this for S3/R2/Supabase
// Storage before relying on it for anything you can't afford to lose.
const UPLOADS_DIR = path.join(__dirname, "..", "data", "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// Compresses uploaded videos in the background (see media.js); photos are optimised during upload.
// With Cloudflare R2 (see storage.js) files live in the bucket and UPLOADS_DIR is not used for media;
// videos are only kept briefly in TMP_DIR while ffmpeg works on them.
const TMP_DIR = path.join(__dirname, "..", "data", "tmp-video");
const remoteKeys = new Map(); // video file name -> its key in R2
let videos;
if (storage.enabled) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  videos = createVideoCompressor(TMP_DIR, {
    remote: {
      // Replaces the uploaded original with the compressed version under the same key (so the link doesn't change).
      upload: async (name, file) => {
        const key = remoteKeys.get(name);
        remoteKeys.delete(name);
        if (!key || storage.isDeleted(key)) return;
        await storage.put(key, fs.createReadStream(file), "video/mp4", "public, max-age=31536000, immutable", fs.statSync(file).size);
      },
    },
  });
} else {
  videos = createVideoCompressor(UPLOADS_DIR);
}
// Removes a deleted post/story's files from R2 -- only files in the owner's own folder, whatever the client claims.
function deleteMedia(userId, media) {
  if (!storage.enabled || !media || typeof media !== "object") return;
  const own = `uploads/${userId}/`;
  const keys = [media.url, media.thumbUrl].map(storage.keyFromUrl).filter(k => k && k.startsWith(own));
  storage.remove(keys).catch(() => {});
}
const MAX_UPLOAD_BYTES = 80 * 1024 * 1024; // 80MB, generous enough for a short video clip
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

// gzip JSON responses (feeds, rooms, chat history) -- big bandwidth saver.
app.use(compression());
app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN }));
// /api/upload is deliberately excluded here and given its own, much larger
// limit further down -- a base64-encoded photo/video body can be well over
// this 2mb cap, and Express's body parser enforces whichever limit runs
// first, so leaving that route in this one would reject large uploads
// before they ever reached the route's own parser.
app.use((req, res, next) => {
  if (req.path === "/api/upload" || req.path === "/api/me/avatar") return next();
  express.json({ limit: "2mb" })(req, res, next);
});
// Videos: once a compressed copy exists it is served in place of the original
// (same URL, so nothing stored in chats/posts needs to change).
app.get("/uploads/:file", (req, res, next) => {
  const name = path.basename(String(req.params.file));
  if (!videos.isVideoFile(name)) return next();
  const compressed = videos.compressedFor(name);
  if (!compressed) return next();
  res.set("Cache-Control", "public, max-age=604800, immutable");
  res.type("video/mp4");
  res.sendFile(compressed, err => { if (err && !res.headersSent) next(); });
});
// Filenames are unique and never change, so browsers can cache them hard --
// except a video that's still waiting to be compressed (its bytes will change).
app.use("/uploads", express.static(UPLOADS_DIR, {
  maxAge: "7d",
  immutable: true,
  setHeaders: (res, filePath) => { if (videos.isVideoFile(filePath) && videos.isPending(path.basename(filePath))) res.setHeader("Cache-Control", "public, max-age=60"); },
}));

function id(prefix = "") { return prefix + crypto.randomBytes(12).toString("hex"); }
// Async scrypt: the Sync version blocks the whole server (every request and
// socket) for the ~100ms it takes, which adds up fast during busy logins.
const scrypt = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));
async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return { salt, hash: (await scrypt(password, salt)).toString("hex") }; }
async function verifyPassword(password, user) {
  const a = await scrypt(password, user.salt);
  const b = Buffer.from(String(user.passwordHash || ""), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); return `${body}.${sig}`; }
function verify(token) { if (!token) return null; try { const [body, sig] = token.split("."); const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const data = JSON.parse(Buffer.from(body, "base64url").toString()); return data.exp > Date.now() ? data : null; } catch (_) { return null; } }
// Small (128px) version of one of our own avatar URLs -- loaded for lists, feeds and chat headers instead of the full photo.
function avatarThumb(url) { return url && /\/avatars\/[^/?]+/.test(url) ? url.replace(/(\/avatars\/[^/?]+)/, "$1/thumb") : null; }
function publicUser(user) { return { id: user.id, username: user.username, name: user.name, bio: user.bio || "", avatarUrl: user.avatarUrl || null, avatarThumbUrl: avatarThumb(user.avatarUrl) }; }
// Posts store userName at creation time (so a feed still reads sensibly if
// the author is later removed), but the avatar should always reflect the
// author's *current* profile photo -- otherwise updating your avatar would
// leave every past post showing the old one. This resolves it live from
// the user record on every read instead of caching it on the post.
function postForClient(db, post, viewerId) {
  const author = db.users.find(u => u.id === post.userId);
  const likes = post.likes || [];
  const comments = (post.comments || []).map(c => {
    const cu = db.users.find(u => u.id === c.userId);
    return { ...c, userName: cu ? cu.name : c.userName, userAvatarUrl: cu ? (cu.avatarUrl || null) : null, userAvatarThumbUrl: cu ? avatarThumb(cu.avatarUrl) : null };
  });
  const { likes: _l, comments: _c, audience, ...rest } = post;
  // Only the author is told who a post is limited to.
  const audienceInfo = viewerId && post.userId === viewerId ? { audience: Array.isArray(audience) ? audience : null, audienceCount: Array.isArray(audience) ? audience.length : null } : {};
  return { ...rest, ...audienceInfo, userAvatarUrl: author ? (author.avatarUrl || null) : null, userAvatarThumbUrl: author ? avatarThumb(author.avatarUrl) : null, likeCount: likes.length, likedByMe: viewerId ? likes.includes(viewerId) : false, commentCount: comments.length, comments };
}
// A post is visible to its author and their accepted friends -- likes and
// comments follow the same rule.
// A post/story can optionally be limited to chosen friends (`audience` = list of user ids; null/absent = all friends).
function canViewItem(db, viewerId, item) {
  if (item.userId === viewerId) return true;
  if (!connected(db, viewerId, item.userId)) return false;
  return !Array.isArray(item.audience) || item.audience.includes(viewerId);
}
function canSeePost(db, viewerId, post) { return canViewItem(db, viewerId, post); }
// Reads the requested audience from a request body. undefined/null -> all friends (null). A list is cut down to the author's actual friends.
function readAudience(db, userId, raw) {
  if (raw === undefined || raw === null) return { audience: null };
  if (!Array.isArray(raw)) return { error: "Invalid audience." };
  const friends = friendIds(db, userId);
  const audience = [...new Set(raw.map(String))].filter(i => friends.has(i)).slice(0, 500);
  if (!audience.length) return { error: "Choose at least one person who can see this." };
  return { audience };
}
// `viewerId` lets us resolve a friendlier name/avatar for 1:1 rooms: instead
// of the generic "Direct messages" label, the client can show the other
// person's name.
function roomForClient(db, room, viewerId, { withMessages = true } = {}) {
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
    messages: withMessages ? lastMessagesFor(db, room.id, 200) : [],
  };
}
// Walks the message list backwards and stops as soon as it has `n` messages
// for the room, instead of filtering all (up to 5000) messages every time.
function lastMessagesFor(db, roomId, n) {
  const out = [];
  for (let i = db.messages.length - 1; i >= 0 && out.length < n; i--) if (db.messages[i].roomId === roomId) out.push(db.messages[i]);
  return out.reverse();
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

// Public (an <img> can't send an auth header). The ?v= in avatarUrl changes
// with every upload, so a long cache lifetime is safe.
app.get("/avatars/:userId", async (req, res, next) => {
  try {
    const doc = await (await avatarsCollection()).findOne({ _id: String(req.params.userId) });
    if (!doc || !doc.data) return res.status(404).end();
    res.set("Content-Type", doc.mime || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(Buffer.from(doc.data.buffer));
  } catch (error) { next(error); }
});
app.get("/avatars/:userId/thumb", async (req, res, next) => {
  try {
    const col = await avatarsCollection();
    const doc = await col.findOne({ _id: String(req.params.userId) });
    if (!doc || !doc.data) return res.status(404).end();
    let thumb = doc.thumb ? Buffer.from(doc.thumb.buffer) : null;
    if (!thumb) {
      // Photos saved before thumbnails existed: make one now and remember it.
      const made = await makeAvatarThumb(Buffer.from(doc.data.buffer));
      if (made) { thumb = made; col.updateOne({ _id: doc._id }, { $set: { thumb: new Binary(made), thumbMime: "image/webp" } }).catch(() => {}); }
    }
    res.set("Content-Type", thumb ? (doc.thumb ? doc.mime : "image/webp") || "image/webp" : doc.mime || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800, immutable");
    res.send(thumb || Buffer.from(doc.data.buffer));
  } catch (error) { next(error); }
});
app.get("/", (req, res) => res.json({ service: "music-chat-api", status: "online" }));
app.get("/health", async (req, res, next) => { try { await loadState(); res.json({ ok: true, service: "music-chat-server", storage: "mongodb", media: storage.enabled ? "r2" : "disk" }); } catch (error) { next(error); } });
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

// Profile photo. The app resizes the picture to 512px first and sends it as
// JSON { fileName, mimeType, data: base64 }. We save it, point the signed-in
// user's avatarUrl at it, delete their previous photo file, and return { user }.
app.post("/api/me/avatar", auth, express.json({ limit: "15mb" }), async (req, res, next) => {
  try {
    const { fileName, mimeType, data } = req.body || {};
    if (!data) return res.status(400).json({ error: "No photo received." });
    const type = mimeType || "image/jpeg";
    if (!String(type).startsWith("image/")) return res.status(400).json({ error: "Please choose an image." });
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length) return res.status(400).json({ error: "No photo received." });
    if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: "That photo is too large (max 10MB)." });
    // Saved in MongoDB, NOT on the server's disk: the disk is wiped on every
    // redeploy/restart (Render, Vercel), which used to leave avatarUrl
    // pointing at a file that no longer existed -- a blank profile photo.
    const updatedAt = Date.now();
    // 512px + 128px WebP versions (a few KB each); falls back to the original if conversion isn't possible.
    const opt = await optimizeAvatar(buffer);
    await (await avatarsCollection()).replaceOne(
      { _id: req.user.id },
      opt
        ? { _id: req.user.id, mime: opt.mime, data: new Binary(opt.main), thumb: new Binary(opt.thumb), updatedAt }
        : { _id: req.user.id, mime: String(type), data: new Binary(buffer), updatedAt },
      { upsert: true },
    );
    req.user.avatarUrl = `${publicBaseUrl(req)}/avatars/${req.user.id}?v=${updatedAt}`;
    await saveState(req.db);
    res.json({ user: publicUser(req.user) });
  } catch (error) {
    console.error("[avatar] failed:", error);
    next(error);
  }
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
// be ~1.4x its raw byte size.
const uploadJsonLimit = express.json({ limit: "110mb" });
// Saves one uploaded file, shrinking it on the way in (see media.js), and
// returns what the app needs to show it.
async function storeUpload(req, buffer, fileName, mimeType, userId) {
  const type = mimeType || "application/octet-stream";
  const stem = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
  let ext = extFor(fileName, type) || (type.startsWith("video/") ? ".mp4" : "");
  let out = buffer, outType = type, displayName = fileName, width, height, thumb = null;
  if (type.startsWith("image/")) {
    const opt = await optimizeImage(buffer, type);
    if (opt) {
      out = opt.buffer; outType = opt.mimeType; width = opt.width; height = opt.height; thumb = opt.thumb;
      if (opt.ext) { ext = opt.ext; if (fileName) displayName = fileName.replace(/\.[^./\\]+$/, "") + opt.ext; }
    }
  }
  const filename = `${stem}${ext}`;
  const isVideo = type.startsWith("video/");
  let url, thumbUrl;
  if (storage.enabled) {
    // Cloudflare R2. Photos/audio never change, so they're cached for a year; a video may be swapped for its compressed version soon, so it gets a shorter cache.
    const folder = `uploads/${userId}/`;
    const cache = isVideo ? "public, max-age=3600" : undefined;
    url = await storage.put(folder + filename, out, outType, cache);
    if (thumb) thumbUrl = await storage.put(`${folder}${stem}-t.webp`, thumb, "image/webp");
    if (isVideo && videos.available) {
      remoteKeys.set(filename, folder + filename);
      await fs.promises.writeFile(path.join(TMP_DIR, filename), out);
      videos.enqueue(filename); // compressed in the background, then replaced in R2
    }
  } else {
    // Local disk (development). Async write: writeFileSync would freeze the whole server while a large video is saved.
    await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), out);
    url = `${publicBaseUrl(req)}/uploads/${filename}`;
    if (thumb) { await fs.promises.writeFile(path.join(UPLOADS_DIR, `${stem}-t.webp`), thumb); thumbUrl = `${publicBaseUrl(req)}/uploads/${stem}-t.webp`; }
    if (isVideo) videos.enqueue(filename);
  }
  return { url, thumbUrl, mimeType: outType, fileName: displayName || filename, size: out.length, width, height };
}
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
      if (buffer.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: "That file is too large (max 80MB)." });
      return res.json(await storeUpload(req, buffer, fileName, type, req.user.id));
    } catch (error) {
      console.error("[upload] failed:", error);
      return res.status(500).json({ error: "Upload failed on the server." });
    }
  }
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message === "File too large" ? "That file is too large (max 80MB)." : err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No file received." });
    try {
      // Older app builds: same treatment, read back from the temp file multer wrote.
      const buffer = await fs.promises.readFile(req.file.path);
      await fs.promises.rm(req.file.path, { force: true });
      res.json(await storeUpload(req, buffer, req.file.originalname, req.file.mimetype, req.user.id));
    } catch (error) {
      console.error("[upload] failed:", error);
      res.status(500).json({ error: "Upload failed on the server." });
    }
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
    // Invites are checked and claimed directly in MongoDB (atomically), so a code made with `npm run invite` works immediately and can't be used twice.
    if (!(await findInvite(inviteHash))) return res.status(403).json({ error: "Invalid or already used invitation." });
    const pass = await hashPassword(String(password));
    const user = { id: id("usr_"), username: normalized, name: String(name || username).trim(), bio: "", avatarUrl: null, salt: pass.salt, passwordHash: pass.hash, active: true, createdAt: new Date().toISOString() };
    if (!(await consumeInvite(inviteHash, user.id))) return res.status(403).json({ error: "Invalid or already used invitation." });
    if (db.users.some(u => u.username === normalized)) return res.status(409).json({ error: "Username already exists." });
    db.users.push(user);
    await saveState(db);
    res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) });
  } catch (error) { next(error); }
});

app.post("/api/auth/login", async (req, res, next) => { try { const db = await loadState(); const normalized = String(req.body?.username || "").trim().toLowerCase(); const user = db.users.find(u => u.username === normalized); if (!user || !(await verifyPassword(String(req.body?.password || ""), user))) return res.status(401).json({ error: "Invalid username or password." }); res.json({ token: sign({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }), user: publicUser(user) }); } catch (error) { next(error); } });
app.get("/api/rooms", auth, (req, res) => {
  // One pass over the messages to find each room's latest one (was: filter all messages once per room).
  const lastByRoom = new Map();
  for (const m of req.db.messages) lastByRoom.set(m.roomId, m);
  res.json({
  rooms: req.db.rooms
    .filter(r => r.members.includes(req.user.id))
    .map(r => {
      const isDirect = Boolean(r.directKey);
      const otherUserId = isDirect ? r.members.find(uid => uid !== req.user.id) : null;
      const otherUser = otherUserId ? req.db.users.find(u => u.id === otherUserId) : null;
      const lastMessage = lastByRoom.get(r.id) || null;
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
  });
});
app.post("/api/rooms", auth, async (req, res, next) => { try { const isVoice = Boolean(req.body?.isVoice); const room = { id: id("room_"), name: String(req.body?.name || (isVoice ? "Voice room" : "Private chat")).trim().slice(0, 80), members: [req.user.id], isVoice, createdAt: new Date().toISOString() }; req.db.rooms.push(room); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });
app.post("/api/rooms/:roomId/invite", auth, async (req, res, next) => { try { const room = req.db.rooms.find(r => r.id === req.params.roomId); if (!room || !room.members.includes(req.user.id)) return res.status(403).json({ error: "Not a member." }); if (room.directKey) return res.status(400).json({ error: "Direct messages can't have people added. Start a room instead." }); const target = req.db.users.find(u => u.username === String(req.body?.username || "").trim().toLowerCase()); if (!target) return res.status(404).json({ error: "User not found." }); if (!room.members.includes(target.id)) room.members.push(target.id); await saveState(req.db); res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });

function connected(db, firstId, secondId) { return db.friendRequests.some(r => r.status === "accepted" && ((r.fromUserId === firstId && r.toUserId === secondId) || (r.fromUserId === secondId && r.toUserId === firstId))); }
// All of a person's accepted friends as a Set, built once per request (connected() rescans every friend request on each call).
function friendIds(db, userId) {
  const set = new Set();
  for (const r of db.friendRequests) if (r.status === "accepted") { if (r.fromUserId === userId) set.add(r.toUserId); else if (r.toUserId === userId) set.add(r.fromUserId); }
  return set;
}
function socialUser(user) { return { id: user.id, username: user.username, name: user.name, avatarUrl: user.avatarUrl || null, avatarThumbUrl: avatarThumb(user.avatarUrl) }; }

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

// The signed-in person's friends -- used to pick who can see a post or story.
app.get("/api/friends", auth, (req, res) => {
  const ids = friendIds(req.db, req.user.id);
  res.json({ friends: req.db.users.filter(u => ids.has(u.id) && u.active !== false).map(u => ({ ...socialUser(u), avatarUrl: u.avatarUrl || null })).sort((a, b) => a.name.localeCompare(b.name)) });
});
app.get("/api/users/search", auth, (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  if (!query) return res.json({ users: [] });
  const users = req.db.users.filter(u => u.id !== req.user.id && (u.username.includes(query) || u.name.toLowerCase().includes(query))).slice(0, 20).map(u => ({ ...socialUser(u), connected: connected(req.db, req.user.id, u.id) }));
  res.json({ users });
});
app.get("/api/friends/requests", auth, (req, res) => res.json({ incoming: req.db.friendRequests.filter(r => r.toUserId === req.user.id && r.status === "pending").map(r => ({ ...r, from: socialUser(req.db.users.find(u => u.id === r.fromUserId)) })), outgoing: req.db.friendRequests.filter(r => r.fromUserId === req.user.id && r.status === "pending") }));
app.post("/api/friends/requests", auth, async (req, res, next) => { try { const username = String(req.body?.username || "").trim().toLowerCase(); const userId = String(req.body?.userId || "").trim(); const target = req.db.users.find(u => u.id === userId) || req.db.users.find(u => u.username === username); if (!target || target.id === req.user.id) return res.status(404).json({ error: "User not found." }); if (connected(req.db, req.user.id, target.id) || req.db.friendRequests.some(r => r.status === "pending" && ((r.fromUserId === req.user.id && r.toUserId === target.id) || (r.fromUserId === target.id && r.toUserId === req.user.id)))) return res.status(409).json({ error: "A request already exists." }); const request = { id: id("req_"), fromUserId: req.user.id, toUserId: target.id, status: "pending", createdAt: new Date().toISOString() }; req.db.friendRequests.push(request); await saveState(req.db);
  // Send the notification before responding: on serverless hosts (Vercel) the function can be frozen right after the response.
  await notifyUsers({ io: req.app.locals.io, db: req.db, userIds: [target.id], build: () => ({ kind: "friend_request", title: "New friend request", body: `${req.user.name} wants to connect with you`, tag: `friend-${request.id}` }) }).catch(console.error);
  res.json({ request }); } catch (error) { next(error); } });
app.post("/api/friends/requests/:requestId/accept", auth, async (req, res, next) => { try { const request = req.db.friendRequests.find(r => r.id === req.params.requestId && r.toUserId === req.user.id && r.status === "pending"); if (!request) return res.status(404).json({ error: "Request not found." }); request.status = "accepted"; request.acceptedAt = new Date().toISOString(); const room = getOrCreateDirectRoom(req.db, request.fromUserId, request.toUserId); await saveState(req.db);
  await notifyUsers({ io: req.app.locals.io, db: req.db, userIds: [request.fromUserId], build: uid => { const { messages, members, ...lite } = roomForClient(req.db, room, uid, { withMessages: false }); return { kind: "friend_accept", title: "Friend request accepted", body: `${req.user.name} accepted your request`, tag: `friend-${request.id}`, roomId: room.id, room: lite }; } }).catch(console.error);
  res.json({ room: roomForClient(req.db, room, req.user.id) }); } catch (error) { next(error); } });
app.get("/api/posts", auth, (req, res) => { const friends = friendIds(req.db, req.user.id); res.json({ posts: req.db.posts.filter(p => p.userId === req.user.id || (friends.has(p.userId) && (!Array.isArray(p.audience) || p.audience.includes(req.user.id)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(p => postForClient(req.db, p, req.user.id)) }); });
app.post("/api/posts", auth, async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 2000);
    const media = req.body?.media || null;
    if (!text && !media) return res.status(400).json({ error: "Write something or attach a photo." });
    if (videoTooLong(media, req.body?.duration)) return res.status(400).json({ error: `Videos can be up to ${MAX_VIDEO_SEC} seconds.` });
    const aud = readAudience(req.db, req.user.id, req.body?.audience);
    if (aud.error) return res.status(400).json({ error: aud.error });
    const post = { id: id("post_"), userId: req.user.id, userName: req.user.name, text, media, audience: aud.audience, duration: media ? cleanDuration("post", media, req.body?.duration) : null, music: cleanMusic(req.body?.music), overlays: cleanOverlays(req.body?.overlays), createdAt: new Date().toISOString() };
    req.db.posts.push(post);
    await saveState(req.db);
    res.json({ post: postForClient(req.db, post, req.user.id) });
  } catch (error) { next(error); }
});
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
    if (req.body?.audience !== undefined) {
      const aud = readAudience(req.db, req.user.id, req.body.audience);
      if (aud.error) return res.status(400).json({ error: aud.error });
      post.audience = aud.audience;
    }
    if (post.media && post.media.url && (!media || media.url !== post.media.url)) deleteMedia(req.user.id, post.media);
    post.text = text; post.media = media; post.editedAt = new Date().toISOString();
    await saveState(req.db);
    res.json({ post: postForClient(req.db, post, req.user.id) });
  } catch (error) { next(error); }
});
app.delete("/api/posts/:postId", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post) return res.status(404).json({ error: "Post not found." });
    if (post.userId !== req.user.id) return res.status(403).json({ error: "You can only delete your own posts." });
    req.db.posts = req.db.posts.filter(p => p.id !== req.params.postId);
    await saveState(req.db);
    deleteMedia(req.user.id, post.media);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
// --- How long a post / story plays ---
// Photo posts: 15-30s.  Photo stories: up to 15s.  Videos (post or story): up to 60s.
// The picker in the app enforces this too, but the server is the real gate.
const MAX_VIDEO_SEC = 60;
const PHOTO_LIMITS = { post: { min: 15, max: 30, def: 15 }, story: { min: 3, max: 15, def: 5 } };
const CLIP_SEC = 30; // iTunes previews are 30 seconds long
const MIN_MUSIC_WINDOW_SEC = 5;
function isVideoMedia(media) { return String(media?.mimeType || "").startsWith("video/"); }
// A video longer than the cap (1s of slack for rounding) is rejected outright.
function videoTooLong(media, raw) { const n = Number(raw); return isVideoMedia(media) && Number.isFinite(n) && n > MAX_VIDEO_SEC + 1; }
function cleanDuration(kind, media, raw) {
  const n = Number(raw);
  if (isVideoMedia(media)) return Number.isFinite(n) && n > 0 ? Math.min(MAX_VIDEO_SEC, Math.round(n)) : MAX_VIDEO_SEC;
  const lim = PHOTO_LIMITS[kind];
  return Number.isFinite(n) ? Math.min(lim.max, Math.max(lim.min, Math.round(n))) : lim.def;
}
// --- Music + text overlays attached to posts and stories ---
// Music is a 30-second preview clip chosen from Apple's public iTunes Search
// catalogue (no account/key needed). Only the metadata and the preview URL
// are stored; the audio itself stays on Apple's servers.
function cleanMusic(m) {
  if (!m || typeof m !== "object") return null;
  const previewUrl = String(m.previewUrl || "");
  let host = "";
  try { host = new URL(previewUrl).hostname; } catch (_) { return null; }
  if (!/^https:/.test(previewUrl) || !(host.endsWith(".mzstatic.com") || host.endsWith(".apple.com"))) return null;
  const artwork = String(m.artworkUrl || "");
  // Which part of the 30s preview to play. startSec/endSec are seconds into
  // the clip; the app loops this window for as long as the post/story plays.
  const startSec = Math.min(CLIP_SEC - MIN_MUSIC_WINDOW_SEC, Math.max(0, Math.round(Number(m.startSec) || 0)));
  const rawEnd = Number(m.endSec);
  const endSec = Math.min(CLIP_SEC, Math.max(startSec + MIN_MUSIC_WINDOW_SEC, Number.isFinite(rawEnd) ? Math.round(rawEnd) : CLIP_SEC));
  return { trackId: String(m.trackId || "").slice(0, 40), title: String(m.title || "Unknown song").slice(0, 120), artist: String(m.artist || "").slice(0, 120), artworkUrl: /^https:\/\//.test(artwork) ? artwork.slice(0, 500) : null, previewUrl: previewUrl.slice(0, 500), startSec, endSec };
}
// Text stickers placed on a photo/video. x/y/scale are relative so they look
// the same at any screen size.
function cleanOverlays(list) {
  if (!Array.isArray(list)) return [];
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return list.slice(0, 12).map(o => ({
    id: String(o?.id || id("t_")).slice(0, 40),
    text: String(o?.text || "").slice(0, 200),
    color: /^#[0-9a-fA-F]{6}$/.test(String(o?.color || "")) ? o.color : "#FFFFFF",
    style: o?.style === "box" ? "box" : "plain",
    x: num(o?.x, 0, 1, 0.5), y: num(o?.y, 0, 1, 0.5), scale: num(o?.scale, 0.4, 4, 1),
  })).filter(o => o.text.trim());
}

app.get("/api/music/search", auth, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (!q) return res.json({ results: [] });
  try {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=25&term=${encodeURIComponent(q)}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`iTunes ${r.status}`);
    const data = await r.json();
    const results = (data.results || []).filter(t => t.previewUrl).map(t => ({
      trackId: String(t.trackId), title: t.trackName, artist: t.artistName,
      artworkUrl: t.artworkUrl100 ? t.artworkUrl100.replace("100x100", "300x300") : null,
      previewUrl: t.previewUrl,
    }));
    res.json({ results });
  } catch (error) {
    console.error("[music] search failed:", error.message);
    res.status(502).json({ error: "Music search is unavailable right now. Please try again." });
  }
});

// --- Likes & comments ---
app.post("/api/posts/:postId/like", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post || !canSeePost(req.db, req.user.id, post)) return res.status(404).json({ error: "Post not found." });
    post.likes = post.likes || [];
    const had = post.likes.includes(req.user.id);
    // Optional body { liked: true|false } makes the call idempotent; otherwise toggle.
    const want = typeof req.body?.liked === "boolean" ? req.body.liked : !had;
    if (want && !had) post.likes.push(req.user.id);
    if (!want && had) post.likes = post.likes.filter(u => u !== req.user.id);
    await saveState(req.db);
    if (want && !had && post.userId !== req.user.id) {
      await notifyUsers({ io: req.app.locals.io, db: req.db, userIds: [post.userId], build: () => ({ kind: "post_like", title: "New like", body: `${req.user.name} liked your post`, tag: `like-${post.id}-${req.user.id}`, postId: post.id }) }).catch(console.error);
    }
    res.json({ post: postForClient(req.db, post, req.user.id) });
  } catch (error) { next(error); }
});
app.post("/api/posts/:postId/comments", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post || !canSeePost(req.db, req.user.id, post)) return res.status(404).json({ error: "Post not found." });
    const text = String(req.body?.text || "").trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: "Write a comment first." });
    post.comments = post.comments || [];
    const comment = { id: id("cmt_"), userId: req.user.id, userName: req.user.name, text, createdAt: new Date().toISOString() };
    post.comments.push(comment);
    await saveState(req.db);
    // Post owner hears about every comment; earlier commenters are not pinged (keeps it quiet).
    if (post.userId !== req.user.id) {
      await notifyUsers({ io: req.app.locals.io, db: req.db, userIds: [post.userId], build: () => ({ kind: "post_comment", title: "New comment", body: `${req.user.name}: ${text.slice(0, 100)}`, tag: `comment-${comment.id}`, postId: post.id }) }).catch(console.error);
    }
    res.json({ post: postForClient(req.db, post, req.user.id) });
  } catch (error) { next(error); }
});
app.delete("/api/posts/:postId/comments/:commentId", auth, async (req, res, next) => {
  try {
    const post = req.db.posts.find(p => p.id === req.params.postId);
    if (!post || !canSeePost(req.db, req.user.id, post)) return res.status(404).json({ error: "Post not found." });
    const comment = (post.comments || []).find(c => c.id === req.params.commentId);
    if (!comment) return res.status(404).json({ error: "Comment not found." });
    // The comment's author or the post's owner may remove it.
    if (comment.userId !== req.user.id && post.userId !== req.user.id) return res.status(403).json({ error: "You can't delete this comment." });
    post.comments = post.comments.filter(c => c.id !== comment.id);
    await saveState(req.db);
    res.json({ post: postForClient(req.db, post, req.user.id) });
  } catch (error) { next(error); }
});
// --- Stories (disappear 24 hours after posting) ---
const STORY_TTL_MS = 24 * 3600 * 1000;
// Drops stories older than 24 hours and deletes their files from R2 (keeps storage small). Returns how many were removed.
function purgeExpiredStories(db) {
  const now = Date.now();
  const gone = db.stories.filter(s => s.expiresAt <= now);
  if (!gone.length) return 0;
  db.stories = db.stories.filter(s => s.expiresAt > now);
  for (const s of gone) deleteMedia(s.userId, s.media);
  return gone.length;
}
function storyForClient(db, story, viewerId) {
  const author = db.users.find(u => u.id === story.userId);
  const viewers = story.viewers || [];
  const { viewers: _v, ...rest } = story;
  const audienceInfo = viewerId && story.userId === viewerId ? { audience: Array.isArray(story.audience) ? story.audience : null, audienceCount: Array.isArray(story.audience) ? story.audience.length : null } : { audience: undefined };
  return { ...rest, ...audienceInfo, userAvatarUrl: author ? (author.avatarUrl || null) : null, userAvatarThumbUrl: author ? avatarThumb(author.avatarUrl) : null, viewedByMe: story.userId === viewerId || viewers.includes(viewerId), viewCount: story.userId === viewerId ? viewers.length : undefined };
}
app.get("/api/stories", auth, (req, res) => { const friends = friendIds(req.db, req.user.id); res.json({ stories: req.db.stories.filter(s => s.expiresAt > Date.now() && (s.userId === req.user.id || (friends.has(s.userId) && (!Array.isArray(s.audience) || s.audience.includes(req.user.id))))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(s => storyForClient(req.db, s, req.user.id)) }); });
app.post("/api/stories", auth, async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim().slice(0, 500);
    const media = req.body?.media || null;
    if (!media) return res.status(400).json({ error: "Add a photo or video." });
    if (videoTooLong(media, req.body?.duration)) return res.status(400).json({ error: `Videos can be up to ${MAX_VIDEO_SEC} seconds.` });
    const aud = readAudience(req.db, req.user.id, req.body?.audience);
    if (aud.error) return res.status(400).json({ error: aud.error });
    const story = { id: id("story_"), userId: req.user.id, userName: req.user.name, text, media, audience: aud.audience, duration: cleanDuration("story", media, req.body?.duration), music: cleanMusic(req.body?.music), overlays: cleanOverlays(req.body?.overlays), viewers: [], createdAt: new Date().toISOString(), expiresAt: Date.now() + STORY_TTL_MS };
    // Expired stories are removed for good whenever a new one is saved.
    purgeExpiredStories(req.db);
    req.db.stories.push(story);
    await saveState(req.db);
    res.json({ story: storyForClient(req.db, story, req.user.id) });
  } catch (error) { next(error); }
});
app.post("/api/stories/:storyId/view", auth, async (req, res, next) => {
  try {
    const story = req.db.stories.find(s => s.id === req.params.storyId && s.expiresAt > Date.now());
    if (!story || !canViewItem(req.db, req.user.id, story)) return res.status(404).json({ error: "Story not found." });
    story.viewers = story.viewers || [];
    if (story.userId !== req.user.id && !story.viewers.includes(req.user.id)) { story.viewers.push(req.user.id); await saveState(req.db); }
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete("/api/stories/:storyId", auth, async (req, res, next) => {
  try {
    const story = req.db.stories.find(s => s.id === req.params.storyId);
    if (!story) return res.status(404).json({ error: "Story not found." });
    if (story.userId !== req.user.id) return res.status(403).json({ error: "You can only delete your own stories." });
    req.db.stories = req.db.stories.filter(s => s.id !== story.id);
    await saveState(req.db);
    deleteMedia(req.user.id, story.media);
    res.json({ ok: true });
  } catch (error) { next(error); }
});


// --- Notification inbox (the in-app bell) ---
function myNotifications(db, userId) {
  return (db.notifications || []).filter(n => n.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
app.get("/api/notifications", auth, (req, res) => {
  const list = myNotifications(req.db, req.user.id);
  res.json({ notifications: list.slice(0, 100), unreadCount: list.filter(n => !n.read).length });
});
// Body { ids: [...] } marks those read; { all: true } (or no body) marks everything read.
app.post("/api/notifications/read", auth, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    for (const n of req.db.notifications || []) if (n.userId === req.user.id && (!ids || ids.has(n.id))) n.read = true;
    await saveState(req.db);
    res.json({ unreadCount: myNotifications(req.db, req.user.id).filter(n => !n.read).length });
  } catch (error) { next(error); }
});
app.delete("/api/notifications/:id", auth, async (req, res, next) => {
  try {
    req.db.notifications = (req.db.notifications || []).filter(n => !(n.id === req.params.id && n.userId === req.user.id));
    await saveState(req.db);
    res.json({ unreadCount: myNotifications(req.db, req.user.id).filter(n => !n.read).length });
  } catch (error) { next(error); }
});
app.delete("/api/notifications", auth, async (req, res, next) => {
  try {
    req.db.notifications = (req.db.notifications || []).filter(n => n.userId !== req.user.id);
    await saveState(req.db);
    res.json({ unreadCount: 0 });
  } catch (error) { next(error); }
});

// --- Web push subscriptions (iPhone home-screen app / browsers) ---
app.get("/api/push/public-key", auth, (req, res) => res.json({ publicKey: isPushEnabled() ? pushPublicKey : null }));
app.post("/api/push/subscribe", auth, async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "Invalid push subscription." });
    const others = (req.db.pushSubscriptions || []).filter(s => s.endpoint !== endpoint);
    // A device belongs to whoever subscribed last; keep at most 10 devices per person.
    const mine = others.filter(s => s.userId === req.user.id).slice(-9);
    const rest = others.filter(s => s.userId !== req.user.id);
    req.db.pushSubscriptions = [...rest, ...mine, { userId: req.user.id, endpoint: String(endpoint), keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) }, createdAt: new Date().toISOString() }];
    await saveState(req.db);
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.post("/api/push/unsubscribe", auth, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || "");
    req.db.pushSubscriptions = (req.db.pushSubscriptions || []).filter(s => !(s.endpoint === endpoint && s.userId === req.user.id));
    await saveState(req.db);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: "Server storage is unavailable. Please try again." }); });

module.exports = { app, videos, helpers: { verify, roomForClient, loadState, saveState, purgeExpiredStories } };
