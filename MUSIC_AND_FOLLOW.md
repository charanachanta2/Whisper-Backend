# Music library + follow / follow back

## Music (full-length songs, any part)
- Source: **Jamendo** (full-length, free). Fallback: Apple iTunes 30s previews if Jamendo is unreachable or `JAMENDO_CLIENT_ID` is missing.
- `GET /api/music/search?q=` -> `{ results: [track] }`
- `GET /api/music/browse[?genre=]` -> `{ sections: [{ id, title, tracks }], genres }`
  - "Suggested for you": songs the people you follow used recently + more of your own genres/artists + trending.
  - "Trending now": Jamendo weekly popularity (cached 10 min, so it keeps updating).
- track = `{ trackId, title, artist, artworkUrl, previewUrl (stream URL), durationSec, genre, source }`
- A post/story stores `music.startSec` / `music.endSec` anywhere inside the song (window 5-90 s).

## Follow / follow back
- `POST /api/follow/:userId` follow (instant) - `DELETE /api/follow/:userId` unfollow - `DELETE /api/followers/:userId` remove a follower
- `GET /api/me/connections` -> followers/following, each with `followedByMe` / `followsMe`
- `GET /api/users/search`, `GET /api/users/suggested` carry the same flags (app shows Follow / Following / Follow back)
- You see posts and stories of people **you follow**. Either person following the other is enough to message.
- Existing friendships are converted automatically on first request (accepted = both follow each other).
- Notification kind `follow` is sent when someone follows you (with a Follow back button in the app).
- Old `/api/friends/requests` routes still exist so older app builds don't crash: "request" now just follows.

## Jamendo setup
Set `JAMENDO_CLIENT_ID` in Render. The client secret is NOT needed (it is only for user logins/OAuth).
