const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const sharp = require("sharp");
const { getStore } = require("./store");

// Everything uploaded goes through here. The big wins for "uploads feel slow"
// and "profile picture won't load":
//  * Photos are shrunk server-side (auto-rotated, max 1600px, WebP) so a 6MB
//    camera shot becomes ~150-300KB, and a small thumbnail is made too.
//  * Avatars become a 512px square (+128px thumb), usually 10-30KB.
//  * Files are stored in MongoDB GridFS, so they survive restarts/redeploys.
//    (They used to be written to local disk, which Render wipes on every
//    deploy and Vercel doesn't allow writing to at all -- hence broken
//    pictures.)
//  * Files are served with long-lived cache headers + HTTP Range support, so
//    images are fetched once per device and videos can seek/stream.

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024; // videos / audio / files
const MAX_IMAGE_INPUT_BYTES = 30 * 1024 * 1024;
const ALLOWED_UPLOAD_PREFIXES = ["image/", "video/", "audio/"];
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".avif"]);

const PRESETS = {
  avatar: { main: { size: 512, fit: "cover", quality: 82 }, thumb: { size: 128, fit: "cover", quality: 75 } },
  photo: { main: { size: 1600, fit: "inside", quality: 80 }, thumb: { size: 400, fit: "inside", quality: 70 } },
};

function isAllowedType(mimeType) {
  const type = mimeType || "application/octet-stream";
  return ALLOWED_UPLOAD_PREFIXES.some(p => type.startsWith(p)) || type === "application/octet-stream";
}

function looksLikeImage(mimeType, fileName) {
  if ((mimeType || "").startsWith("image/")) return true;
  return (mimeType || "application/octet-stream") === "application/octet-stream" && IMAGE_EXT.has(path.extname(fileName || "").toLowerCase());
}

const randomName = () => `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;

async function putBuffer(bucket, filename, buffer, contentType) {
  await pipeline(Readable.from([buffer]), bucket.openUploadStream(filename, { metadata: { contentType } }));
}

async function resize(input, { size, fit, quality }) {
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate() // honour phone camera orientation, then drop the EXIF
    .resize({ width: size, height: size, fit, withoutEnlargement: fit === "inside" })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

class UploadError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Stores an upload and returns what the client needs.
 * source: { buffer } or { filePath } (a temp file written by multer).
 * Returns { url, thumbUrl, mimeType, fileName, size, width, height }.
 */
async function storeUpload({ buffer, filePath, mimeType, fileName, purpose, baseUrl }) {
  if (!isAllowedType(mimeType)) throw new UploadError("Unsupported file type.");
  const { bucket } = await getStore();
  const base = randomName();

  if (looksLikeImage(mimeType, fileName)) {
    const input = buffer || (await fs.promises.readFile(filePath));
    if (input.length > MAX_IMAGE_INPUT_BYTES) throw new UploadError("That image is too large (max 30MB).");
    const preset = PRESETS[purpose] || PRESETS.photo;
    const isGif = mimeType === "image/gif" && purpose !== "avatar";
    let main, thumb;
    try {
      // Animated GIFs are kept as-is so they still animate; everything else is optimised.
      main = isGif ? { data: input, info: await sharp(input, { failOn: "none" }).metadata() } : await resize(input, preset.main);
      thumb = await resize(input, preset.thumb);
    } catch (_) {
      throw new UploadError("We couldn't read that image. Try a JPG or PNG.", 415);
    }
    const ext = isGif ? ".gif" : ".webp";
    const mainName = `${base}${ext}`;
    const thumbName = `${base}-t.webp`;
    await Promise.all([
      putBuffer(bucket, mainName, main.data, isGif ? "image/gif" : "image/webp"),
      putBuffer(bucket, thumbName, thumb.data, "image/webp"),
    ]);
    return {
      url: `${baseUrl}/uploads/${mainName}`,
      thumbUrl: `${baseUrl}/uploads/${thumbName}`,
      mimeType: isGif ? "image/gif" : "image/webp",
      fileName: fileName || mainName,
      size: main.data.length,
      width: main.info.width || null,
      height: main.info.height || null,
    };
  }

  // Video / audio / other: stored untouched (streamed straight from the temp
  // file when we have one, so a big video never sits fully in memory).
  const size = buffer ? buffer.length : (await fs.promises.stat(filePath)).size;
  if (size > MAX_UPLOAD_BYTES) throw new UploadError("That file is too large (max 80MB).");
  const ext = path.extname(fileName || "").slice(0, 10).replace(/[^\w.]/g, "");
  const name = `${base}${ext}`;
  const type = mimeType || "application/octet-stream";
  const upload = bucket.openUploadStream(name, { metadata: { contentType: type } });
  await pipeline(buffer ? Readable.from([buffer]) : fs.createReadStream(filePath), upload);
  return { url: `${baseUrl}/uploads/${name}`, thumbUrl: null, mimeType: type, fileName: fileName || name, size, width: null, height: null };
}

// Deletes a previously uploaded file (and its thumbnail) given its public URL.
async function deleteByUrl(url) {
  try {
    const match = /\/uploads\/([\w.-]+)$/.exec(String(url || ""));
    if (!match) return;
    const { bucket } = await getStore();
    const names = [match[1]];
    if (!match[1].includes("-t.")) names.push(match[1].replace(/\.\w+$/, "-t.webp"));
    for (const name of names) {
      const file = await bucket.find({ filename: name }).limit(1).next();
      if (file) await bucket.delete(file._id);
    }
  } catch (_) { /* best effort cleanup */ }
}

// GET /uploads/:name -- streams a stored file with caching + Range support.
async function serveUpload(req, res, next) {
  try {
    const name = req.params.name;
    if (!/^[\w.-]+$/.test(name)) return next();
    const { bucket } = await getStore();
    const file = await bucket.find({ filename: name }).limit(1).next();
    if (!file) return next(); // fall through to any legacy on-disk file
    const etag = `"${file._id}"`;
    res.set({
      "Content-Type": file.metadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable", // names are unique, so content never changes
      ETag: etag,
      "Accept-Ranges": "bytes",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let start = 0;
    let end = file.length - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      else { start = Math.max(file.length - Number(range[2]), 0); } // "last N bytes"
      if (start > end || start >= file.length) {
        res.set("Content-Range", `bytes */${file.length}`);
        return res.status(416).end();
      }
      res.status(206).set("Content-Range", `bytes ${start}-${end}/${file.length}`);
    }
    res.set("Content-Length", String(file.length ? end - start + 1 : 0));
    if (!file.length) return res.end();
    const stream = bucket.openDownloadStream(file._id, { start, end: end + 1 });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } catch (error) { next(error); }
}

module.exports = { storeUpload, deleteByUrl, serveUpload, UploadError, MAX_UPLOAD_BYTES, ALLOWED_UPLOAD_PREFIXES };
