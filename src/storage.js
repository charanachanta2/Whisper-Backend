// File storage for uploaded photos, videos and voice messages.
//
// With Cloudflare R2 configured (R2_* env vars below) every upload goes to an R2
// bucket and the app loads it straight from R2's public URL -- the backend never
// serves media bytes, files survive redeploys, and R2 has no download fees.
// Without those variables the backend falls back to its own disk (fine for local
// development; wiped on every Render deploy).
//
//   R2_ACCOUNT_ID         Cloudflare account id
//   R2_ACCESS_KEY_ID      R2 API token: access key id   (needs "Object Read & Write")
//   R2_SECRET_ACCESS_KEY  R2 API token: secret
//   R2_BUCKET             bucket name
//   R2_PUBLIC_URL         public address of the bucket, no trailing slash:
//                         your custom domain (recommended) or the bucket's r2.dev URL
//   R2_ENDPOINT           (optional) override the S3 endpoint -- only for testing
let S3 = null;
try { S3 = require("@aws-sdk/client-s3"); } catch (_) { /* package missing: disk fallback */ }

const {
  R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT,
} = process.env;
const PUBLIC_URL = String(process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

const configured = Boolean(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && PUBLIC_URL && (R2_ACCOUNT_ID || R2_ENDPOINT));
const partlyConfigured = Boolean(R2_ACCESS_KEY_ID || R2_SECRET_ACCESS_KEY || R2_BUCKET || process.env.R2_PUBLIC_URL || R2_ACCOUNT_ID);
if (partlyConfigured && !configured) {
  console.warn("[storage] R2 is only partly configured (need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL) -- using local disk for uploads.");
}
if (configured && !S3) console.warn("[storage] @aws-sdk/client-s3 is not installed -- using local disk for uploads.");
const enabled = Boolean(configured && S3);

let client = null;
if (enabled) {
  client = new S3.S3Client({
    region: "auto",
    endpoint: R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    forcePathStyle: Boolean(R2_ENDPOINT),
    // R2 doesn't need the extra checksums newer AWS SDK versions add by default.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  console.log(`[storage] Cloudflare R2 bucket "${R2_BUCKET}" -> ${PUBLIC_URL}`);
} else {
  console.log("[storage] using the server's local disk for uploads (set the R2_* variables to use Cloudflare R2).");
}

const urlFor = (key) => `${PUBLIC_URL}/${key.split("/").map(encodeURIComponent).join("/")}`;

// Our key for one of our own public URLs, or null if the URL isn't ours.
function keyFromUrl(url) {
  if (!enabled || typeof url !== "string" || !url.startsWith(PUBLIC_URL + "/")) return null;
  try { return decodeURIComponent(url.slice(PUBLIC_URL.length + 1).split(/[?#]/)[0]); } catch (_) { return null; }
}

// Keys deleted recently, so a background video job can't bring a deleted post's file back.
const deleted = new Set();
const isDeleted = (key) => deleted.has(key);

async function put(key, body, contentType, cacheControl, contentLength) {
  await client.send(new S3.PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType || "application/octet-stream",
    CacheControl: cacheControl || "public, max-age=31536000, immutable",
    ...(contentLength != null ? { ContentLength: contentLength } : {}),
  }));
  deleted.delete(key);
  return urlFor(key);
}

async function remove(keys) {
  const list = [...new Set(keys.filter(Boolean))];
  if (!enabled || !list.length) return;
  for (const k of list) { deleted.add(k); if (deleted.size > 2000) deleted.delete(deleted.values().next().value); }
  try {
    await client.send(new S3.DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: list.map((Key) => ({ Key })), Quiet: true } }));
  } catch (error) { console.error("[storage] delete failed:", error.message); }
}

module.exports = { enabled, put, remove, urlFor, keyFromUrl, isDeleted };
