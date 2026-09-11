const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { loadState, saveState } = require("./store");

const app = express();
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "*";
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "change-me-session-secret";
const INVITE_SECRET = process.env.INVITE_SECRET || "change-me-invite-secret";

app.use(cors({ origin: CLIENT_ORIGIN === "*" ? true : CLIENT_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

function id(prefix = "") { return prefix + crypto.randomBytes(12).toString("hex"); }
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) { return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") }; }
function verifyPassword(password, user) { return crypto.scryptSync(password, user.salt, 64).toString("hex") === user.passwordHash; }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); const sig = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); return `${body}.${sig}`; }
function verify(token) { if (!token) return null; try { const [body, sig] = token.split("."); const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url"); if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; const data = JSON.parse(Buffer.from(body, "base64url").toString()); return data.exp > Date.now() ? data : null; } catch (_) { return null; } }
function publicUser(user) { return { id: user.id, username: user.username, name: user.name }; }
function roomForClient(db, room) { return { id: room.id, name: room.name, memberCount: room.members.length, members: room.members.map(uid => db.users.find(u => u.id === uid)).filter(Boolean).map(publicUser), messages: db.messages.filter(m => m.roomId === room.id).slice(-200), playback: room.playback }; }

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
app.get("/api/rooms", auth, (req, res) => res.json({ rooms: req.db.rooms.filter(r => r.members.includes(req.user.id)).map(r => ({ id: r.id, name: r.name, memberCount: r.members.length })) }));
app.post("/api/rooms", auth, async (req, res, next) => { try { const room = { id: id("room_"), name: String(req.body?.name || "Private chat").trim().slice(0, 80), members: [req.user.id], playback: { trackId: null, title: "Nothing playing", artist: "", url: "", position: 0, isPlaying: false, updatedBy: null, updatedAt: Date.now() }, createdAt: new Date().toISOString() }; req.db.rooms.push(room); await saveState(req.db); res.json({ room: roomForClient(req.db, room) }); } catch (error) { next(error); } });
app.post("/api/rooms/:roomId/invite", auth, async (req, res, next) => { try { const room = req.db.rooms.find(r => r.id === req.params.roomId); if (!room || !room.members.includes(req.user.id)) return res.status(403).json({ error: "Not a member." }); const target = req.db.users.find(u => u.username === String(req.body?.username || "").trim().toLowerCase()); if (!target) return res.status(404).json({ error: "User not found." }); if (!room.members.includes(target.id)) room.members.push(target.id); await saveState(req.db); res.json({ room: roomForClient(req.db, room) }); } catch (error) { next(error); } });

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: "Server storage is unavailable. Please try again." }); });

module.exports = { app, helpers: { verify, roomForClient, loadState, saveState } };
