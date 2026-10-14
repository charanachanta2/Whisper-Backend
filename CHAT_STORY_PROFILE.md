# Story viewers, delete chat, followers/following

## Who viewed a story
- `POST /api/stories/:id/view` now also records *when* each person viewed (`viewTimes`, private to the author).
- `GET /api/stories/:id/viewers` (author only, story must still be live) ->
  `{ viewers: [{ id, username, name, avatarUrl, avatarThumbUrl, viewedAt }], viewCount }`, newest first.
- `GET /api/stories` / `POST /api/stories` also return `viewerUsers` (same list) on **your own** stories. Everyone else never receives it.
- Views recorded before this update have `viewedAt: null` (shown without a time).

## Delete a chat (direct messages only)
`DELETE /api/rooms/:roomId`
- Clears the conversation **for the person who deleted it only**. The other person keeps their copy.
- The chat disappears from that person's `/api/rooms` list and its old messages are never sent to them again (`room_state`, `lastMessage`).
- It comes back, empty, when they open it again with `POST /api/dm/:userId` (Chats -> search a friend's name, or Discover -> Message),
  and it reappears on its own when anyone sends a new message in it (they only see messages from that point on).
- Group rooms return 400 (only `directKey` rooms can be deleted).
- Stored on the room as `clearedAt: { [userId]: ISO }` and `hidden: { [userId]: true }`. Existing data needs no migration.

## Followers / following
`GET /api/me/connections` -> `{ followers: [user], following: [user], followersCount, followingCount }`
- **Following** = people you sent a request to who accepted it.
- **Followers** = people whose request you accepted.
- Friendships stay mutual (both people see each other's posts and stories and can message); this only decides which list a person is counted in.

## Profile pictures in chat
No API change: `room_state.members` and `/api/rooms` -> `otherUser` already include `avatarUrl` / `avatarThumbUrl`; the app now uses them in the chat header and beside each incoming message.
