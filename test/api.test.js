process.env.ADMIN_SESSION_SECRET = "test-secret";
process.env.INVITE_SECRET = "test-invite";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");
const sharp = require("sharp");
const { io: connect } = require("socket.io-client");
const { createFakeStore } = require("./fakeStore");
const store = require("../src/store");
const fake = createFakeStore();
store._setStoreForTests(fake);
const { app } = require("../src/app");

let server, base, Server;
const call = async (method, path, { token, body, headers } = {}) => {
  const res = await fetch(base + path, { method, headers: { ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, res };
};
const addInvite = async code => { const hash = crypto.createHmac("sha256", "test-invite").update(code).digest("hex"); await fake.invites.insertOne({ _id: hash, hash, used: false, expiresAt: Date.now() + 1e6 }); };
const register = async (username, code) => { await addInvite(code); return (await call("POST", "/api/auth/register", { body: { username, password: "password123", name: username.toUpperCase(), inviteCode: code } })).json; };

test.before(async () => {
  const { Server: IOServer } = require("socket.io");
  server = http.createServer(app); Server = new IOServer(server);
  // reuse the real realtime handlers by loading index.js logic against our server
  await new Promise(r => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

let alice, bob;
test("register / login / invite single-use", async () => {
  alice = await register("alice", "CODE1"); bob = await register("bob", "CODE2");
  assert.ok(alice.token && alice.user.id);
  const reuse = await call("POST", "/api/auth/register", { body: { username: "eve", password: "password123", inviteCode: "CODE1" } });
  assert.equal(reuse.status, 403);
  const dupName = await call("POST", "/api/auth/register", { body: { username: "alice", password: "password123", inviteCode: "CODE1" } });
  assert.equal(dupName.status, 409);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "Alice", password: "password123" } })).status, 200);
  assert.equal((await call("POST", "/api/auth/login", { body: { username: "alice", password: "wrongwrong" } })).status, 401);
  assert.equal((await call("GET", "/api/me")).status, 401);
  assert.equal((await call("GET", "/api/me", { token: alice.token })).json.user.username, "alice");
});

// A big, noisy "camera" photo: 4000x3000 random pixels saved as a high-quality JPEG.
let bigJpeg;
test("photo upload (JSON base64) is shrunk, stored durably and served with cache headers", async () => {
  bigJpeg = await sharp({ create: { width: 4000, height: 3000, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 95 }).toBuffer();
  const t0 = Date.now();
  const r = await call("POST", "/api/upload", { token: alice.token, body: { fileName: "IMG_1.jpg", mimeType: "image/jpeg", data: bigJpeg.toString("base64") } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  console.log(`   original ${(bigJpeg.length / 1e6).toFixed(2)}MB -> stored ${(r.json.size / 1e3).toFixed(0)}KB (${r.json.width}x${r.json.height}) in ${Date.now() - t0}ms`);
  assert.ok(r.json.size < bigJpeg.length / 5);
  assert.ok(Math.max(r.json.width, r.json.height) <= 1600);
  assert.match(r.json.url, /\/uploads\/.+\.webp$/); assert.match(r.json.thumbUrl, /-t\.webp$/);
  const img = await fetch(r.json.url.replace(/^.*?(\/uploads)/, base + "$1"));
  assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/webp");
  assert.match(img.headers.get("cache-control"), /immutable/);
  const etag = img.headers.get("etag"); await img.arrayBuffer();
  const again = await fetch(r.json.url.replace(/^.*?(\/uploads)/, base + "$1"), { headers: { "If-None-Match": etag } });
  assert.equal(again.status, 304);
  const thumb = await fetch(r.json.thumbUrl.replace(/^.*?(\/uploads)/, base + "$1")); const tb = Buffer.from(await thumb.arrayBuffer());
  assert.ok(tb.length < 40000, "thumb should be tiny, was " + tb.length); assert.ok((await sharp(tb).metadata()).width <= 400);
});

test("multipart upload works too, bad images are rejected cleanly", async () => {
  const fd = new FormData(); fd.append("file", new Blob([bigJpeg], { type: "image/jpeg" }), "a.jpg");
  const r = await call("POST", "/api/upload", { token: alice.token, body: fd });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(r.json.size < bigJpeg.length / 5);
  const bad = await call("POST", "/api/upload", { token: alice.token, body: { fileName: "x.jpg", mimeType: "image/jpeg", data: Buffer.from("not an image").toString("base64") } });
  assert.equal(bad.status, 415);
  const pdf = await call("POST", "/api/upload", { token: alice.token, body: { fileName: "x.pdf", mimeType: "application/pdf", data: "AAAA" } });
  assert.equal(pdf.status, 400);
  assert.equal((await call("POST", "/api/upload", { body: { data: "AAAA" } })).status, 401);
});

test("video is stored as-is and supports Range requests", async () => {
  const video = crypto.randomBytes(5000);
  const r = await call("POST", "/api/upload", { token: alice.token, body: { fileName: "clip.mp4", mimeType: "video/mp4", data: video.toString("base64") } });
  assert.equal(r.status, 200); assert.equal(r.json.size, 5000);
  const url = r.json.url.replace(/^.*?(\/uploads)/, base + "$1");
  const part = await fetch(url, { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206); assert.equal(part.headers.get("content-range"), "bytes 100-199/5000");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), video.subarray(100, 200));
  const tail = await fetch(url, { headers: { Range: "bytes=-50" } });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.subarray(4950));
  assert.equal((await fetch(url, { headers: { Range: "bytes=9000-" } })).status, 416);
  assert.deepEqual(Buffer.from(await (await fetch(url)).arrayBuffer()), video);
});

test("avatar: one call resizes to 512px, saves on profile, replaces & cleans up the old one", async () => {
  const a1 = await call("POST", "/api/me/avatar", { token: alice.token, body: { fileName: "me.jpg", mimeType: "image/jpeg", data: bigJpeg.toString("base64") } });
  assert.equal(a1.status, 200, JSON.stringify(a1.json));
  const u = a1.json.user; console.log(`   avatar ${(a1.json.upload.size / 1e3).toFixed(0)}KB ${a1.json.upload.width}x${a1.json.upload.height}`);
  assert.equal(a1.json.upload.width, 512); assert.equal(a1.json.upload.height, 512);
  assert.match(u.avatarThumbUrl, /-t\.webp$/);
  assert.equal((await call("GET", "/api/me", { token: alice.token })).json.user.avatarUrl, u.avatarUrl);
  const filesBefore = fake.bucket.files.length;
  const a2 = await call("POST", "/api/me/avatar", { token: alice.token, body: { fileName: "me2.jpg", mimeType: "image/jpeg", data: bigJpeg.toString("base64") } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(fake.bucket.files.length, filesBefore, "old avatar + thumb removed, new pair added");
  assert.equal((await fetch(u.avatarUrl.replace(/^.*?(\/uploads)/, base + "$1"))).status, 404, "old avatar gone");
  assert.equal((await fetch(a2.json.user.avatarUrl.replace(/^.*?(\/uploads)/, base + "$1"))).status, 200);
  const p = await call("PATCH", "/api/me", { token: alice.token, body: { name: "Alice A", bio: "hi" } });
  assert.equal(p.json.user.name, "Alice A"); assert.equal(p.json.user.avatarUrl, a2.json.user.avatarUrl);
});

test("friends, DM room, search, posts feed with live avatars", async () => {
  const s = await call("GET", "/api/users/search?q=BO", { token: alice.token });
  assert.equal(s.json.users.length, 1); assert.equal(s.json.users[0].connected, false);
  const fr = await call("POST", "/api/friends/requests", { token: alice.token, body: { username: "bob" } });
  assert.equal(fr.status, 200);
  assert.equal((await call("POST", "/api/friends/requests", { token: alice.token, body: { username: "bob" } })).status, 409);
  const inc = await call("GET", "/api/friends/requests", { token: bob.token });
  assert.equal(inc.json.incoming.length, 1); assert.equal(inc.json.incoming[0].from.username, "alice");
  assert.ok("avatarThumbUrl" in inc.json.incoming[0].from);
  assert.equal((await call("POST", `/api/friends/requests/${fr.json.request.id}/accept`, { token: alice.token })).status, 404, "only recipient may accept");
  const acc = await call("POST", `/api/friends/requests/${fr.json.request.id}/accept`, { token: bob.token });
  assert.equal(acc.status, 200); assert.equal(acc.json.room.isDirect, true); assert.equal(acc.json.room.otherUser.username, "alice");
  const dm = await call("POST", `/api/dm/${bob.user.id}`, { token: alice.token });
  assert.equal(dm.json.room.id, acc.json.room.id, "same DM room, no duplicate");
  assert.equal((await call("GET", "/api/users/search?q=bob", { token: alice.token })).json.users[0].connected, true);

  const post = await call("POST", "/api/posts", { token: alice.token, body: { text: "hello", media: { url: "x" } } });
  assert.ok(post.json.post.userAvatarUrl);
  const feed = await call("GET", "/api/posts", { token: bob.token });
  assert.equal(feed.json.posts.length, 1); assert.ok(feed.json.posts[0].userAvatarUrl);
  assert.equal((await call("PUT", `/api/posts/${post.json.post.id}`, { token: bob.token, body: { text: "hax" } })).status, 403);
  assert.equal((await call("PUT", `/api/posts/${post.json.post.id}`, { token: alice.token, body: { text: "edited" } })).json.post.text, "edited");
  assert.equal((await call("DELETE", `/api/posts/${post.json.post.id}`, { token: alice.token })).status, 200);
  assert.equal((await call("GET", "/api/posts", { token: bob.token })).json.posts.length, 0);
  const story = await call("POST", "/api/stories", { token: alice.token, body: { text: "s" } });
  assert.equal((await call("GET", "/api/stories", { token: bob.token })).json.stories.length, 1);
  assert.ok(story.json.story.expiresAt > Date.now());
});

test("realtime: join, send, persist, chat list preview, paging", async () => {
  // Boot the real realtime layer on a second port by loading index.js.
  process.env.PORT = "0";
  const { Server: IO } = require("socket.io");
  delete require.cache[require.resolve("../src/index.js")];
  const realPort = 40000 + Math.floor(Math.random() * 1000); process.env.PORT = String(realPort);
  require("../src/index.js"); await new Promise(r => setTimeout(r, 300));
  const url = `http://127.0.0.1:${realPort}`;
  const rooms = (await call("GET", "/api/rooms", { token: alice.token })).json.rooms; const roomId = rooms[0].id;
  const sa = connect(url, { auth: { token: alice.token }, transports: ["websocket"] });
  const sb = connect(url, { auth: { token: bob.token }, transports: ["websocket"] });
  const once = (s, ev) => new Promise(r => s.once(ev, r));
  await Promise.all([once(sa, "connect"), once(sb, "connect")]);
  const stateA = once(sa, "room_state"); sa.emit("join_room", { roomId }); const st = await stateA;
  assert.equal(st.messages.length, 0); assert.equal(st.members.length, 2);
  sb.emit("join_room", { roomId }); await once(sb, "room_state");
  const incoming = once(sb, "new_message");
  const ack = await new Promise(r => sa.emit("send_message", { roomId, text: "hi bob", type: "text" }, r));
  assert.equal(ack.ok, true); assert.equal((await incoming).text, "hi bob");
  for (let i = 0; i < 4; i++) await new Promise(r => sa.emit("send_message", { roomId, type: "media", url: "https://x/y.webp", thumbUrl: "https://x/y-t.webp", mimeType: "image/webp", text: "m" + i }, r));
  await new Promise(r => setTimeout(r, 50));
  const list = (await call("GET", "/api/rooms", { token: bob.token })).json.rooms;
  assert.equal(list[0].lastMessage.text, "m3"); assert.equal(list[0].name, "Alice A");
  const page = await call("GET", `/api/rooms/${roomId}/messages?limit=2`, { token: bob.token });
  assert.deepEqual(page.json.messages.map(m => m.text), ["m2", "m3"]);
  const older = await call("GET", `/api/rooms/${roomId}/messages?limit=10&before=${encodeURIComponent(page.json.messages[0].createdAt)}`, { token: bob.token });
  assert.ok(older.json.messages.length >= 1 && older.json.messages.every(m => m.createdAt < page.json.messages[0].createdAt));
  const bad = await new Promise(r => sa.emit("send_message", { roomId: "nope", text: "x" }, r)); assert.equal(bad.ok, false);
  const empty = await new Promise(r => sa.emit("send_message", { roomId, text: "  " }, r)); assert.equal(empty.ok, false);
  const stranger = await register("carl", "CODE3"); const sc = connect(url, { auth: { token: stranger.token }, transports: ["websocket"] }); await once(sc, "connect");
  const denied = once(sc, "error_message"); sc.emit("join_room", { roomId }); assert.match(await denied, /not a member/);
  const noAuth = connect(url, { auth: { token: "junk" }, transports: ["websocket"] }); assert.match((await once(noAuth, "connect_error")).message, /Unauthorized/);
  [sa, sb, sc, noAuth].forEach(s => s.close());
});

test("legacy single-document data is migrated", async () => {
  const f = createFakeStore();
  await f.legacy.insertOne({ _id: "state", users: [{ id: "u1", username: "old", name: "Old" }], rooms: [{ id: "r1", name: "R", members: ["u1"], messages: [] }], invites: [{ hash: "h1", used: false }], messages: [{ id: "m1", roomId: "r1", text: "hey", type: "text", userName: "Old", createdAt: "2024-01-01T00:00:00.000Z" }], friendRequests: [], posts: [{ id: "p1", userId: "u1", text: "t", createdAt: "x" }], stories: [] });
  await store.migrateLegacy(f); await store.migrateLegacy(f); // second run is a no-op
  assert.equal((await f.users.findOne({ _id: "u1" })).username, "old");
  assert.equal((await f.rooms.findOne({ _id: "r1" })).lastMessage.text, "hey");
  assert.equal(f.messages.docs.length, 1); assert.equal(f.invites.docs[0]._id, "h1"); assert.equal(f.posts.docs.length, 1);
});
