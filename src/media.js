// Media pipeline: makes uploaded photos and videos much smaller without a
// visible drop in quality.
//
//  * Photos  -> re-encoded as WebP (visually the same at q82, usually 30-60%
//               smaller than the JPEG the phone sends), capped at 2048px on the
//               long edge, camera metadata (incl. GPS location) removed, plus a
//               small thumbnail for chat bubbles / lists. Done instantly while
//               the upload request is open.
//  * Videos  -> saved as-is so the upload returns immediately, then compressed
//               in the background with ffmpeg (H.264 + AAC, max 1080p, CRF 23,
//               "faststart" for instant playback). One at a time, at low CPU
//               priority, so chat stays responsive. Once done, /uploads/<file>
//               transparently serves the small version and the original is
//               deleted. If the result isn't clearly smaller (or the video is
//               HDR, which would wash out when converted) the original is kept.
//
// Tuning (all optional env vars): IMAGE_MAX_PX, IMAGE_QUALITY, VIDEO_COMPRESSION=off,
// VIDEO_MAX_PX, VIDEO_CRF, VIDEO_PRESET, VIDEO_THREADS, VIDEO_CONCURRENCY, FFMPEG_PATH.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let sharp = null;
try {
  sharp = require("sharp");
  sharp.cache(false);
  sharp.concurrency(Number(process.env.SHARP_THREADS) || 2);
} catch (error) {
  console.warn("[media] sharp is not installed -- photos will be stored as uploaded.");
}

const IMAGE_MAX_PX = Number(process.env.IMAGE_MAX_PX) || 2048;
const IMAGE_QUALITY = Number(process.env.IMAGE_QUALITY) || 82;
const THUMB_PX = 480;
const VIDEO_ON = String(process.env.VIDEO_COMPRESSION || "on").toLowerCase() !== "off" && !process.env.VERCEL; // serverless hosts can't run background jobs
const VIDEO_MAX_PX = Number(process.env.VIDEO_MAX_PX) || 1920; // long edge: 1920 = "1080p"
const VIDEO_CRF = String(process.env.VIDEO_CRF || 23);
const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";
const VIDEO_THREADS = String(process.env.VIDEO_THREADS || 2);
const VIDEO_CONCURRENCY = Math.max(1, Number(process.env.VIDEO_CONCURRENCY) || 1);
const VIDEO_TIMEOUT_MS = 15 * 60 * 1000;
const KEEP_IF_SAVING_BELOW = 0.08; // keep the original unless the new file is at least 8% smaller

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) { try { ffmpegPath = require("ffmpeg-static"); } catch (_) { ffmpegPath = null; } }
if (!ffmpegPath) {
  const probe = spawnSync("ffmpeg", ["-version"]);
  if (!probe.error && probe.status === 0) ffmpegPath = "ffmpeg";
}
if (VIDEO_ON && !ffmpegPath) console.warn("[media] ffmpeg not found -- videos will be stored as uploaded.");
const hasNice = !spawnSync("nice", ["-n", "0", "true"]).error;

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".3gp", ".mpg", ".mpeg"]);
const MIME_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif", "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/3gpp": ".3gp", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/webm": ".webm", "audio/ogg": ".ogg" };

function extFor(fileName, mime) {
  const fromName = path.extname(fileName || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
  return fromName || MIME_EXT[String(mime || "").toLowerCase()] || "";
}
const isVideoFile = (name) => VIDEO_EXTS.has(path.extname(name).toLowerCase());

// ---------------------------------------------------------------- photos
// Returns { buffer, mimeType, ext, width, height, thumb } or null if the buffer
// can't/shouldn't be converted (GIF, SVG, unreadable data, sharp missing).
async function optimizeImage(buffer, mime) {
  const type = String(mime || "").toLowerCase();
  if (!sharp || type === "image/gif" || type === "image/svg+xml") return null;
  try {
    const base = () => sharp(buffer, { failOn: "none" }).rotate(); // .rotate() applies the camera's orientation, then metadata is dropped
    const main = await base()
      .resize({ width: IMAGE_MAX_PX, height: IMAGE_MAX_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: IMAGE_QUALITY, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const thumb = await base()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 70, effort: 3 })
      .toBuffer();
    // Already tiny/optimal? Keep the original bytes (but still return the thumbnail).
    const keepOriginal = main.data.length >= buffer.length * 0.97 && /^image\/(jpeg|png|webp)$/.test(type);
    // Small photos don't need a separate thumbnail: the main file is already tiny, so
    // skip it and store just one object in R2 (the caller falls back to the main URL).
    const small = Math.max(main.info.width, main.info.height) <= THUMB_PX * 1.5 || main.data.length < 40 * 1024;
    return {
      buffer: keepOriginal ? buffer : main.data,
      mimeType: keepOriginal ? type : "image/webp",
      ext: keepOriginal ? null : ".webp",
      width: main.info.width,
      height: main.info.height,
      thumb: small ? null : thumb,
    };
  } catch (error) {
    console.error("[media] image optimize failed, storing original:", error.message);
    return null;
  }
}

// Profile photos: a 512px picture and a 128px thumbnail, both WebP.
async function optimizeAvatar(buffer) {
  if (!sharp) return null;
  try {
    const base = () => sharp(buffer, { failOn: "none" }).rotate();
    const main = await base().resize({ width: 512, height: 512, fit: "cover" }).webp({ quality: 85, effort: 4 }).toBuffer();
    const thumb = await base().resize({ width: 128, height: 128, fit: "cover" }).webp({ quality: 78, effort: 3 }).toBuffer();
    return { main, thumb, mime: "image/webp" };
  } catch (error) {
    console.error("[media] avatar optimize failed:", error.message);
    return null;
  }
}
async function makeAvatarThumb(buffer) {
  if (!sharp) return null;
  try { return await sharp(buffer, { failOn: "none" }).rotate().resize({ width: 128, height: 128, fit: "cover" }).webp({ quality: 78 }).toBuffer(); }
  catch (_) { return null; }
}

// ---------------------------------------------------------------- videos
// `dir` holds the files being worked on. Without `remote` (local-disk mode) the
// compressed copy sits next to the original and is served in its place. With
// `remote` ({ upload(name, filePath) }) the files in `dir` are only temporary:
// the finished video is handed to remote.upload() (Cloudflare R2) and removed.
function createVideoCompressor(dir, { remote = null } = {}) {
  const queue = [];
  const queued = new Set();
  let running = 0;
  const p = (name) => path.join(dir, name);
  const baseOf = (name) => name.replace(/\.[^.]+$/, "");
  const exists = (file) => fs.existsSync(file);

  // Compressed copy, if one exists for an uploaded video's filename.
  function compressedFor(name) {
    const file = p(`${baseOf(name)}.c.mp4`);
    return exists(file) ? file : null;
  }
  // True while a video is waiting for (or in the middle of) compression.
  function isPending(name) { return queued.has(name); }

  function ffmpegInfo(file) {
    return new Promise((resolve) => {
      const child = spawn(ffmpegPath, ["-hide_banner", "-i", file]);
      let text = "";
      child.stderr.on("data", (d) => { if (text.length < 60000) text += d; });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(text));
    });
  }

  function encode(src, out) {
    return new Promise((resolve, reject) => {
      const scale = `scale='if(gt(iw,ih),min(${VIDEO_MAX_PX},iw),-2)':'if(gt(iw,ih),-2,min(${VIDEO_MAX_PX},ih))',scale=trunc(iw/2)*2:trunc(ih/2)*2`;
      const args = ["-y", "-nostdin", "-v", "error", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", scale,
        "-c:v", "libx264", "-preset", VIDEO_PRESET, "-crf", VIDEO_CRF, "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-map_metadata", "-1", "-threads", VIDEO_THREADS, "-f", "mp4", out];
      const child = hasNice ? spawn("nice", ["-n", "10", ffmpegPath, ...args]) : spawn(ffmpegPath, args);
      let err = "";
      child.stderr.on("data", (d) => { if (err.length < 4000) err += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), VIDEO_TIMEOUT_MS);
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `ffmpeg exited with ${code}`)); });
    });
  }

  async function run(name) {
    const src = p(name);
    const base = baseOf(name);
    const tmp = p(`${base}.tmp.mp4`);
    const done = p(`${base}.c.mp4`);
    const skip = p(`${base}.skip`);
    // Nothing more to do for this video: keep the original as it is.
    const keepOriginal = (reason) => {
      if (remote) fs.rmSync(src, { force: true }); // the original already lives in remote storage
      else { try { fs.writeFileSync(skip, reason); } catch (_) {} }
    };
    try {
      if (!exists(src)) return;
      // HDR (iPhone Dolby Vision/HLG) would look washed out when flattened to 8-bit SDR -- keep those untouched.
      const info = await ffmpegInfo(src);
      if (/smpte2084|arib-std-b67/i.test(info)) return keepOriginal("hdr");
      await encode(src, tmp);
      const before = fs.statSync(src).size;
      const after = fs.statSync(tmp).size;
      if (after > before * (1 - KEEP_IF_SAVING_BELOW)) { fs.rmSync(tmp, { force: true }); return keepOriginal("no-gain"); }
      if (remote) {
        await remote.upload(name, tmp);
        fs.rmSync(tmp, { force: true });
      } else {
        fs.renameSync(tmp, done);
      }
      fs.rmSync(src, { force: true });
      console.log(`[media] compressed ${name}: ${(before / 1048576).toFixed(1)}MB -> ${(after / 1048576).toFixed(1)}MB`);
    } catch (error) {
      console.error(`[media] could not compress ${name}:`, error.message);
      fs.rmSync(tmp, { force: true });
      keepOriginal("failed");
    }
  }

  function pump() {
    while (running < VIDEO_CONCURRENCY && queue.length) {
      const name = queue.shift();
      running++;
      run(name).finally(() => { running--; queued.delete(name); pump(); });
    }
  }

  function enqueue(name) {
    if (!VIDEO_ON || !ffmpegPath || queued.has(name) || !isVideoFile(name)) return;
    const base = baseOf(name);
    if (exists(p(`${base}.c.mp4`)) || exists(p(`${base}.skip`))) return;
    queued.add(name);
    queue.push(name);
    pump();
  }

  // After a restart: pick up videos that were uploaded but not compressed yet.
  function resumePending() {
    if (remote) {
      // Temporary files from before a restart: the originals are already in remote storage, so just clean up.
      try { for (const name of fs.readdirSync(dir)) fs.rmSync(p(name), { force: true, recursive: true }); } catch (_) {}
      return;
    }
    if (!VIDEO_ON || !ffmpegPath) return;
    try {
      for (const name of fs.readdirSync(dir)) if (isVideoFile(name) && !/\.(c|tmp)\.mp4$/.test(name)) enqueue(name);
      for (const name of fs.readdirSync(dir)) if (/\.tmp\.mp4$/.test(name)) fs.rmSync(p(name), { force: true });
    } catch (_) {}
  }

  return { enqueue, compressedFor, isPending, resumePending, isVideoFile, available: VIDEO_ON && Boolean(ffmpegPath) };
}

module.exports = { optimizeImage, optimizeAvatar, makeAvatarThumb, createVideoCompressor, extFor, isVideoFile };
