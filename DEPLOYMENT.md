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

## Voice chat (LiveKit)

Voice rooms previously only tracked who had "joined" — no audio was ever
actually captured or sent. Real audio needs WebRTC, and specifically a TURN
relay server for it to work reliably across different networks/NATs — and
that's the one piece Render's free tier genuinely cannot host itself, since
TURN needs raw UDP and Render's free web services only accept HTTP(S). This
app now uses [LiveKit Cloud](https://cloud.livekit.io) to handle that part;
this Render service's only job is to prove someone is really a member of a
voice room before handing them a scoped token — the audio itself never
touches Render at all.

1. Create a free LiveKit Cloud account/project at
   [cloud.livekit.io](https://cloud.livekit.io) (the free tier is generous
   for a small app — check their current pricing page for limits).
2. In the project's **Settings → Keys**, copy the API Key, API Secret, and
   the **WebSocket URL** (starts with `wss://`, not `https://`).
3. Set three env vars on Render (already in `render.yaml`):
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
   - `LIVEKIT_URL` — the `wss://...` URL from step 2
4. Voice rooms return a clear "Voice chat isn't configured on this server
   yet." error until all three are set; everything else in the app works
   fine without them.
5. On the mobile side, voice chat needs `react-native-webrtc` (a native
   module), which means **Expo Go can no longer run this app** — you'll
   need an EAS development build or a bare/prebuilt project. See the
   "Voice chat" section in the project's top-level `README.md` for the
   client-side setup.
