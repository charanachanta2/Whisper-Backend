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

async function loadState() {
  const document = await (await collection()).findOne({ _id: "state" });
  if (!document) return emptyState();
  const { _id, ...state } = document;
  return { ...emptyState(), ...state };
}

async function saveState(state) {
  await (await collection()).replaceOne(
    { _id: "state" },
    { _id: "state", ...state },
    { upsert: true },
  );
}

module.exports = { emptyState, loadState, saveState };
