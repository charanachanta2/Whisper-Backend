const { MongoClient } = require("mongodb");

// Local commands (including `npm run invite`) read server/.env. Hosting
// providers supply the same variables directly, so this is harmless there.
require("dotenv").config();

let clientPromise;

// Everything except `invites` lives in one shared "state" document. Invites
// are handled with their own atomic operations (see below) so that an invite
// created by `npm run invite` from another process is never overwritten by
// this server's in-memory copy of the state.
const STATE_KEYS = ["users", "rooms", "messages", "friendRequests", "posts", "stories", "pushSubscriptions", "notifications"];

function emptyState() {
  return { users: [], rooms: [], invites: [], messages: [], friendRequests: [], posts: [], stories: [], pushSubscriptions: [], notifications: [] };
}

function db() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  if (!clientPromise) {
    const client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  return clientPromise.then(client => client.db(process.env.MONGODB_DB || "music_chat"));
}
async function collection() { return (await db()).collection("app_state"); }

// Profile photos live in their own collection (not inside the big shared
// "state" document) so they survive redeploys and don't bloat every read.
async function avatarsCollection() { return (await db()).collection("avatars"); }

// ---------------------------------------------------------------------------
// State access
//
// Before: every request (and every socket event) downloaded the ENTIRE state
// document from MongoDB and wrote the entire document back on every change.
// A single chat message caused two full reads and two full writes.
//
// Now, on the long-running server (src/index.js calls enableCache()):
//   * the state is read from MongoDB once and kept in memory;
//   * saveState() only marks it dirty -- changes are written to MongoDB in one
//     batched write at most once per FLUSH_MS, and only the parts that changed;
//   * the in-memory copy is shared, so concurrent requests can no longer
//     overwrite each other's changes (the old load-modify-save race).
// One-off processes and serverless hosts (Vercel) don't call enableCache(), so
// they keep reading/writing MongoDB directly, as before.
// ---------------------------------------------------------------------------
const FLUSH_MS = Number(process.env.STATE_FLUSH_MS) || 1000;
let cacheEnabled = false;
let cache = null;
let cachePromise = null;
let flushTimer = null;
let flushing = null;
let dirty = false;
const lastWritten = {};

function enableCache() { cacheEnabled = true; }

async function readState() {
  const document = await (await collection()).findOne({ _id: "state" }, { projection: { invites: 0 } });
  if (!document) return emptyState();
  const { _id, ...state } = document;
  return { ...emptyState(), ...state };
}

async function writeKeys(state, keys) {
  const $set = {};
  for (const key of keys) $set[key] = state[key] || [];
  if (!Object.keys($set).length) return;
  await (await collection()).updateOne({ _id: "state" }, { $set }, { upsert: true });
}

async function loadState() {
  if (!cacheEnabled) return readState();
  if (cache) return cache;
  if (!cachePromise) {
    cachePromise = readState()
      .then(state => {
        cache = state;
        for (const key of STATE_KEYS) lastWritten[key] = JSON.stringify(state[key] || []);
        return state;
      })
      .finally(() => { cachePromise = null; });
  }
  return cachePromise;
}

async function flushOnce() {
  const changed = [];
  const serialized = {};
  for (const key of STATE_KEYS) {
    const json = JSON.stringify(cache[key] || []);
    if (json !== lastWritten[key]) { changed.push(key); serialized[key] = json; }
  }
  if (!changed.length) return;
  await writeKeys(cache, changed);
  Object.assign(lastWritten, serialized);
}

function flush() {
  if (flushing) return flushing;
  clearTimeout(flushTimer); flushTimer = null;
  flushing = (async () => {
    try {
      while (dirty) {
        dirty = false;
        await flushOnce();
      }
    } catch (error) {
      console.error("[store] could not write to MongoDB, will retry:", error.message);
      dirty = true;
      flushTimer = setTimeout(() => { flushTimer = null; flush(); }, 2000);
    } finally { flushing = null; }
  })();
  return flushing;
}

async function saveState(state) {
  if (!cacheEnabled) return writeKeys(state, STATE_KEYS);
  cache = state;
  dirty = true;
  if (!flushTimer && !flushing) flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_MS);
}

// Called on shutdown so nothing waiting in the batch is lost.
async function flushNow() {
  if (!cacheEnabled || !cache) return;
  dirty = true;
  await flush();
}

// --- Invitations (atomic, always straight against MongoDB) ---------------
async function addInvite(invite) {
  await (await collection()).updateOne({ _id: "state" }, { $push: { invites: invite } }, { upsert: true });
}
async function findInvite(hash) {
  const doc = await (await collection()).findOne({ _id: "state" }, { projection: { invites: 1 } });
  return (doc?.invites || []).find(i => i.hash === hash && !i.used && (!i.expiresAt || i.expiresAt > Date.now())) || null;
}
// Returns true only for the one caller that actually claimed the invite.
async function consumeInvite(hash, userId) {
  const res = await (await collection()).updateOne(
    { _id: "state", invites: { $elemMatch: { hash, used: false } } },
    { $set: { "invites.$.used": true, "invites.$.usedBy": userId, "invites.$.usedAt": Date.now() } },
  );
  return res.modifiedCount === 1;
}

module.exports = { avatarsCollection, emptyState, loadState, saveState, enableCache, flushNow, addInvite, findInvite, consumeInvite };
