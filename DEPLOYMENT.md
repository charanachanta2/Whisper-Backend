# Backend deployment

## Temporary Vercel deployment

This backend includes `api/index.js` and `vercel.json` for Vercel.

Set these Vercel environment variables:
- `ADMIN_SESSION_SECRET`
- `INVITE_SECRET`
- `MONGODB_URI`
- `MONGODB_DB` (optional; defaults to `music_chat`)

After deployment, test:
- `https://YOUR-VERCEL-DOMAIN/health`
- `https://YOUR-VERCEL-DOMAIN/`

### Important limitation
Vercel serverless functions are not suitable for the persistent Socket.IO server used by realtime chat. The Vercel entrypoint is therefore REST-only. The persistent `src/index.js` remains included for the later Render deployment.

All accounts, invitation codes, rooms, and messages are stored in MongoDB. Add the same `MONGODB_URI`, `MONGODB_DB`, and `INVITE_SECRET` to your local `server/.env` before running `npm run invite`. This makes the generated invitation available to the deployed Vercel API.

## Later Render deployment

Use the existing `src/index.js` and `render.yaml`. That process starts Express + Socket.IO and is the preferred realtime deployment. Point the mobile app's `EXPO_PUBLIC_API_URL` to the Render service URL.

For the split Vercel + Render setup, keep `EXPO_PUBLIC_API_URL` pointed at
Vercel and set `EXPO_PUBLIC_SOCKET_URL` to the Render service URL instead.
Use `.env.render.example` as the Render environment-variable checklist.
