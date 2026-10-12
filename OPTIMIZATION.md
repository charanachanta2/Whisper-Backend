# What changed (performance + media)

## Why it felt slow
1. **One giant database document.** Every request -- including every chat
   message -- loaded and re-saved *all* users, messages, posts and stories as a
   single MongoDB document. It slowed down with every message sent.
2. **Photos were uploaded and stored at full size** (several MB each, as
   base64) and written to local disk. On Render the disk is wiped on every
   restart/deploy and on Vercel it's read-only, so uploaded pictures (like
   profile photos) came back broken or never loaded.
3. Passwords were hashed with a blocking call, freezing the server for
   everyone during each login.

## What it does now
- Separate indexed collections (users, rooms, messages, ...). Your existing
  data is **copied automatically on first start**; the old document is left
  as a backup (`app_state`).
- Uploaded files live in MongoDB GridFS (survive redeploys), are served with
  1-year cache headers + ETag + Range (video seeking).
- Photos: auto-rotated, max 1600px WebP (+400px thumbnail). Avatars: 512px
  (+128px thumbnail). Typically 10-300KB instead of several MB.
- `POST /api/me/avatar` -- upload + resize + save profile photo in one call
  (and deletes the previous photo).
- Responses include `avatarThumbUrl` (128px) next to `avatarUrl` (512px);
  `/api/upload` returns `thumbUrl`, `width`, `height`.
- gzip responses, async password hashing, websocket-first Socket.IO,
  chat-list previews stored on the room (no scanning all messages),
  `GET /api/rooms/:id/messages?before=&limit=` for loading older messages.
- Invite codes are redeemed atomically; direct-message rooms can't be duplicated.

All existing routes and response shapes are unchanged, so the current app
keeps working. Tests: `npm test` (uses an in-memory stand-in for MongoDB).

## App-side changes that make the biggest difference
(the app code I was given does not contain the upload/profile screens, so
these are the changes to make in your real app)
1. Shrink before uploading -- `expo-image-manipulator`:
   `manipulateAsync(uri, [{ resize: { width: 1600 } }], { compress: 0.7, format: SaveFormat.JPEG })`
   (use width 512 for avatars). Also pass `quality: 0.7` to the image picker.
2. Upload as multipart instead of base64 (about a third smaller):
   ```js
   const form = new FormData();
   form.append("file", { uri, name: "photo.jpg", type: "image/jpeg" });
   await fetch(`${API_URL}/api/me/avatar`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
   ```
3. Show pictures with `expo-image` (disk cache + fade-in + placeholder) rather
   than RN's `Image`: `<Image source={{ uri: user.avatarThumbUrl }} style={{width:44,height:44,borderRadius:22}} cachePolicy="disk" transition={150} />`
   Use `avatarThumbUrl` in lists/chat, `avatarUrl` on the profile screen.
4. Send photos through the **Render** URL (not Vercel): Vercel rejects request
   bodies over ~4.5MB.

## Also worth doing
- Keep the MongoDB Atlas cluster in the same region as the Render service.
- Render's free tier sleeps when idle (first request takes ~30s). A paid
  instance, or an uptime pinger hitting `/`, avoids that.
- Atlas free tier has 512MB; photos are now small, but if you store lots of
  video, move media to Cloudflare R2/S3 later.
