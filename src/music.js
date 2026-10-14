// Music catalogue, tried in order: Jamendo (full-length, needs JAMENDO_CLIENT_ID; no secret needed),
// then Apple's iTunes 30-second previews so the picker is never empty.
// Only metadata + the stream URL are stored on posts/stories; audio is streamed from Jamendo.
const GENRES = ["Electronic", "Hip-Hop/Rap", "Pop", "Alternative", "Rock", "R&B/Soul", "Lo-Fi", "Ambient", "Dance & EDM", "Acoustic"];

const cache = new Map(); // key -> { at, value }
function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return loader().then(value => { cache.set(key, { at: Date.now(), value }); if (cache.size > 300) cache.delete(cache.keys().next().value); return value; });
}

function fromItunes(t) {
  if (!t || !t.previewUrl) return null;
  return {
    trackId: String(t.trackId), source: "itunes", title: t.trackName, artist: t.artistName,
    artworkUrl: t.artworkUrl100 ? t.artworkUrl100.replace("100x100", "300x300") : null,
    previewUrl: t.previewUrl, durationSec: 30, genre: t.primaryGenreName || null,
  };
}


// --- Jamendo (full-length, free, Creative Commons). Needs a free client id: https://devportal.jamendo.com ---
const JAMENDO_ID = process.env.JAMENDO_CLIENT_ID || "";
const JAM_TAGS = { "Electronic": "electronic", "Hip-Hop/Rap": "hiphop", "Pop": "pop", "Alternative": "alternative", "Rock": "rock", "R&B/Soul": "rnb", "Lo-Fi": "lounge", "Ambient": "ambient", "Dance & EDM": "dance", "Acoustic": "acoustic" };
async function jamendo(params) {
  if (!JAMENDO_ID) throw new Error("JAMENDO_CLIENT_ID not set");
  const qs = new URLSearchParams({ client_id: JAMENDO_ID, format: "json", include: "musicinfo", audioformat: "mp32", ...params }).toString();
  const r = await fetch(`https://api.jamendo.com/v3.0/tracks/?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Jamendo ${r.status}`);
  const body = await r.json();
  if (body.headers && body.headers.status === "failed") throw new Error(`Jamendo: ${body.headers.error_message}`);
  return (body.results || []).map(fromJamendo).filter(Boolean);
}
function fromJamendo(t) {
  if (!t || !t.id || !t.audio || t.audio_allowed === false) return null;
  let url = String(t.audio); if (url.startsWith("http://")) url = "https://" + url.slice(7);
  return {
    trackId: `jm_${t.id}`, source: "jamendo", title: String(t.name || "Unknown song").slice(0, 120), artist: String(t.artist_name || "").slice(0, 120),
    artworkUrl: t.image ? String(t.image).replace("http://", "https://") : null, previewUrl: url,
    durationSec: Math.max(1, Math.round(Number(t.duration) || 0)) || 180, genre: t.musicinfo?.tags?.genres?.[0] || null,
  };
}

async function searchTracks(q, limit = 25) {
  q = String(q || "").trim().slice(0, 100);
  if (!q) return [];
  return cached(`s:${q.toLowerCase()}:${limit}`, 5 * 60 * 1000, async () => {
    try { const list = await jamendo({ namesearch: q, limit, order: "popularity_total" }); if (list.length) return list; } catch (e) { if (JAMENDO_ID) console.error("[music] jamendo search failed:", e.message); }
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=${limit}&term=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`iTunes ${r.status}`);
    return ((await r.json()).results || []).map(fromItunes).filter(Boolean);
  });
}

// What's popular right now. Cached for 10 minutes, so the list keeps moving with Jamendo's weekly charts.
async function trendingTracks({ genre, time = "week", limit = 25 } = {}) {
  return cached(`t:${genre || ""}:${time}:${limit}`, 10 * 60 * 1000, async () => {
    try {
      const jp = { limit, order: "popularity_week" }; if (genre) jp.tags = JAM_TAGS[genre] || String(genre).toLowerCase().replace(/[^a-z0-9]/g, "");
      const list = await jamendo(jp); if (list.length) return list;
    } catch (e) { if (JAMENDO_ID) console.error("[music] jamendo trending failed:", e.message); }
    // Last resort so the picker is never empty: Apple's top-song search (30s previews).
    const r = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=${limit}&term=${encodeURIComponent(genre || "top hits")}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`iTunes ${r.status}`);
    return ((await r.json()).results || []).map(fromItunes).filter(Boolean);
  });
}

// Songs for a person: what the people they follow have been using, plus more of the genres/artists
// they pick themselves, topped up with what is trending now. Anything they already used is left out.
async function suggestTracks(db, userId, followingSet, limit = 30) {
  const recent = [...(db.posts || []), ...(db.stories || [])].filter(i => i.music && i.music.trackId);
  const mine = recent.filter(i => i.userId === userId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 12);
  const used = new Set(mine.map(i => i.music.trackId));
  const out = [], seen = new Set();
  const add = (t) => { if (t && !seen.has(t.trackId) && !used.has(t.trackId)) { seen.add(t.trackId); out.push(t); } };

  const weekAgo = Date.now() - 14 * 24 * 3600 * 1000;
  const counts = new Map();
  for (const i of recent) if (followingSet.has(i.userId) && Date.parse(i.createdAt) > weekAgo) { const c = counts.get(i.music.trackId) || { n: 0, m: i.music }; c.n++; counts.set(i.music.trackId, c); }
  const fromFriends = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 8).map(c => ({ trackId: c.m.trackId, source: String(c.m.trackId).startsWith("jm_") ? "jamendo" : "itunes", title: c.m.title, artist: c.m.artist, artworkUrl: c.m.artworkUrl, previewUrl: c.m.previewUrl, durationSec: c.m.durationSec || 30, genre: c.m.genre || null, reason: "Friends are using this" }));

  const tally = (key) => { const m = new Map(); for (const i of mine) { const v = i.music[key]; if (v) m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); };
  const genres = tally("genre").slice(0, 2), artists = tally("artist").slice(0, 2);
  const jobs = [
    ...genres.map(g => trendingTracks({ genre: g, limit: 15 }).then(l => l.map(t => ({ ...t, reason: `Because you like ${g}` })))),
    ...artists.map(a => searchTracks(a, 10).then(l => l.map(t => ({ ...t, reason: `More like ${a}` })))),
    trendingTracks({ limit: 25 }).then(l => l.map(t => ({ ...t, reason: "Trending now" }))),
  ];
  const settled = await Promise.allSettled(jobs);
  fromFriends.forEach(add);
  // Interleave so one source doesn't crowd out the others.
  const lists = settled.filter(s => s.status === "fulfilled").map(s => s.value);
  for (let i = 0; out.length < limit && lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) add(l[i]);
  return out.slice(0, limit);
}

// Hosts a stored stream URL may point to.
function allowedAudioHost(host) {
  return host.endsWith(".mzstatic.com") || host.endsWith(".apple.com") || host.endsWith(".jamendo.com") || host === "jamendo.com";
}

module.exports = { searchTracks, trendingTracks, suggestTracks, allowedAudioHost, GENRES };
