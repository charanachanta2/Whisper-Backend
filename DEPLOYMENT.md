# Backend deployment

## Render — single deployment (only supported setup)

`server/src/index.js` runs the Express REST API and the Socket.IO realtime
server together on one process/port. Deploy that one service to Render and
point **both** `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SOCKET_URL` in
`mobile/.env` at its URL.

This is deliberate: earlier this app was split across a Vercel REST
deployment and a separate Render Socket.IO deployment. Vercel's serverless
functions can't hold the persistent connection Socket.IO needs, and running
two deployments meant `ADMIN_SESSION_SECRET`, `INVITE_SECRET`, and
`MONGODB_URI` all had to match exactly across two separate dashboards. Any
drift between them showed up as a login that "succeeds" over REST but then
gets rejected the instant a chat opens, with the app forced back to the
sign-in screen — the "session keeps expiring" symptom. Running one Render
service for everything removes that whole class of bug: there's only ever
one secret, one invite secret, and one database in play.

### Setup

1. Create a Render **Web Service**, `rootDir: server` (already set in
   `render.yaml`), build command `npm install`, start command `npm start`.
2. Set these environment variables in Render's dashboard:
   - `ADMIN_SESSION_SECRET` — any long random string
   - `INVITE_SECRET` — any long random string
   - `MONGODB_URI` — your MongoDB connection string
   - `MONGODB_DB` — defaults to `music_chat` if unset
   - `CLIENT_ORIGIN` — `*` is fine to start; lock this down to your app's
     origin once you're ready for production
3. Deploy, then confirm `https://YOUR-RENDER-SERVICE.onrender.com/health`
   returns `{"ok":true,...}`.
4. In `mobile/.env`, set both:
   ```
   EXPO_PUBLIC_API_URL=https://YOUR-RENDER-SERVICE.onrender.com
   EXPO_PUBLIC_SOCKET_URL=https://YOUR-RENDER-SERVICE.onrender.com
   ```
5. Generate invite codes with `npm run invite` from the `server/` folder —
   it uses the same `.env` locally, so make sure `MONGODB_URI`,
   `MONGODB_DB`, and `INVITE_SECRET` in your local `server/.env` match what's
   set on Render (otherwise a code created locally won't validate against
   the deployed database).

### Render free-tier note

Free Render web services spin down after periods of inactivity and take a
few seconds to wake back up on the next request — the first login or socket
connect after idle time may be slow or briefly fail before Render finishes
starting the instance. That's expected on the free tier, not a bug; a paid
instance stays warm.

## Notifications
Set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT (generate with `npx web-push generate-vapid-keys`) to enable
OS push for the PWA. Without them the in-app pop-ups still work. Friend-request notifications are now sent before the
HTTP response so they aren't lost when a serverless function freezes after replying.

## Photo & video compression

Uploads are shrunk on the server automatically (see `src/media.js`):

- **Photos** become WebP (quality 82, max 2048px, location/camera metadata removed) and get a
  480px thumbnail. Profile photos get a 512px + 128px version.
- **Videos** are saved immediately, then compressed in the background with ffmpeg
  (H.264/AAC, max 1080p, CRF 23). Once finished, the same `/uploads/...` URL serves the
  smaller file and the original is deleted. HDR videos and videos that wouldn't get at least
  8% smaller are left untouched.

`ffmpeg-static` and `sharp` install with `npm install` (no extra setup on Render). Optional
environment variables: `VIDEO_COMPRESSION=off` (turn video compression off), `VIDEO_CRF`
(default 23; higher = smaller/lower quality), `VIDEO_PRESET` (default `veryfast`; `fast`/`medium`
= smaller files but more CPU), `VIDEO_MAX_PX` (default 1920), `VIDEO_THREADS` (default 2),
`IMAGE_MAX_PX` (default 2048), `IMAGE_QUALITY` (default 82).

Video compression uses CPU. On a small Render plan a 30-60s clip can take a few minutes to
compress (chat stays responsive; one video is processed at a time). Note that `data/uploads`
is on the server's disk, which is wiped on every redeploy -- use Cloudflare R2 (next section).

## Cloudflare R2 (free tier) for photos, videos and voice messages

With R2 set up, every upload is stored in your R2 bucket and the app loads it straight from
Cloudflare (the backend never serves media). Files survive redeploys, and R2 has no download
fees. Free tier: 10 GB stored, 1M uploads and 10M downloads per month. If the `R2_*` variables
are not set, the backend keeps using its own disk.

### One-time setup (Cloudflare dashboard)

1. **R2 Object Storage -> Create bucket** (e.g. `hush-media`). R2 needs a payment method on the
   account, but you are not charged within the free tier.
2. **Make the bucket public.** Bucket -> Settings -> Public access:
   - *Custom domain* (recommended, needs a domain on Cloudflare, e.g. `media.yourdomain.com`) -- fast,
     cached by Cloudflare's CDN, fine for production; or
   - *R2.dev subdomain* -- quickest to try, but Cloudflare rate-limits it and says it is meant for development.
3. **CORS policy** (Bucket -> Settings -> CORS policy), so the web app can play videos:
   ```json
   [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 86400 }]
   ```
4. **API token:** R2 -> Manage API tokens -> Create API token -> permission *Object Read & Write*,
   limited to this bucket. Copy the Access Key ID and Secret Access Key (shown once).
5. **Render -> Environment**, add:
   - `R2_ACCOUNT_ID` -- your Cloudflare account id (R2 overview page, right side)
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` -- from step 4
   - `R2_BUCKET` -- the bucket name
   - `R2_PUBLIC_URL` -- the public address from step 2, no trailing slash
     (e.g. `https://media.yourdomain.com` or `https://pub-xxxx.r2.dev`)
6. Redeploy and open `/health`: it should show `"media":"r2"`.

### How it behaves

- Files are stored as `uploads/<userId>/<file>` in the bucket.
- Deleting a post or story (or a story expiring after 24 hours -- checked every hour) also
  deletes its files from R2, so storage stays small. Only a person's own files can be deleted this way.
- A video is available immediately; its smaller compressed version replaces it in the bucket a
  little later (same link). If the server restarts while a video is still compressing, that video
  simply stays in its original size.
- Profile photos are small (about 25 KB) and stay in MongoDB.
- Files uploaded before you switched to R2 are not moved.
