const { MongoClient } = require("mongodb");

// Local commands (including `npm run invite`) read server/.env. Hosting
// providers supply the same variables directly, so this is harmless there.
require("dotenv").config();

let clientPromise;

function emptyState() {
  return { users: [], rooms: [], invites: [], messages: [], friendRequests: [], posts: [], stories: [] };
}

async function collection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  if (!clientPromise) {
    const client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  return client.db(process.env.MONGODB_DB || "music_chat").collection("app_state");
}

// --- In-memory cache over the single "state" document ---
//
// Before this cache existed, loadState() ran a fresh findOne() against
// Mongo on *every* authenticated HTTP request and *every* socket event
// (join_room, leave_room, send_message, voice_join, voice_leave,
// voice_update -- literally all of them), even ones that don't touch any
// data, like just opening a chat screen. On a free-tier Render instance
// talking to a free-tier Mongo cluster, that's a network round trip on
// nearly every tap in the app, and it's the single biggest source of lag.
//
// This process is a single Node instance (not a cluster), and every route
// already receives the *same* `db` object reference and mutates it in
// place before calling saveState(db) -- so keeping that object in memory
// between calls doesn't change any behavior, it just stops re-fetching
// data that's already sitting right there.
//
// The one thing that *does* write to this Mongo document from outside this
// process is `npm run invite` (server/scripts/create-invite.js), run as a
// separate one-off script. To make sure an invite created that way shows up
// without needing a server restart, the cache isn't held forever -- it
// re-syncs with Mongo every CACHE_TTL_MS. That still collapses the flood of
// reads triggered by normal in-app activity down to at most one Mongo read
// per window, while keeping external writes visible within a few seconds.
const CACHE_TTL_MS = Number(process.env.STATE_CACHE_TTL_MS) || 8000;
// Writes are debounced by this much so a burst of activity (several chat
// messages sent back-to-back, a few reactions in a row) collapses into one
// Mongo write instead of one per mutation. A background sweep further down
// guarantees a dirty write still lands even if nothing triggers another
// save soon after.
const SAVE_DEBOUNCE_MS = Number(process.env.STATE_SAVE_DEBOUNCE_MS) || 300;

let cachedState = null;
let cachedAt = 0;
let dirty = false;
let saveTimer = null;

async function loadState() {
  const now = Date.now();
  if (cachedState && (dirty || now - cachedAt < CACHE_TTL_MS)) return cachedState;
  const document = await (await collection()).findOne({ _id: "state" });
  const { _id, ...rest } = document || {};
  cachedState = { ...emptyState(), ...rest };
  cachedAt = now;
  return cachedState;
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  const snapshot = cachedState;
  try {
    await (await collection()).replaceOne(
      { _id: "state" },
      { _id: "state", ...snapshot },
      { upsert: true },
    );
    cachedAt = Date.now();
  } catch (error) {
    console.error("[store] failed to persist state, will retry:", error);
    dirty = true; // leave it dirty so the next scheduled save or sweep retries
  }
}

// Safety net: if a save was scheduled but the process never got another
// write to trigger the timer (or the Mongo write above failed), this makes
// sure dirty state doesn't just sit in memory indefinitely. unref() so this
// timer never keeps the process alive by itself.
setInterval(() => { if (dirty && !saveTimer) flush(); }, 5000).unref();

async function saveState(state) {
  cachedState = state;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, SAVE_DEBOUNCE_MS);
}

// Called on process shutdown so a debounced-but-not-yet-written save isn't
// lost when Render stops/restarts the instance.
async function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await flush();
}

module.exports = { emptyState, loadState, saveState, shutdown, flush };
