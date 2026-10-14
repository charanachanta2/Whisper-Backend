# Reply, delete and react to messages

All three work over the existing Socket.IO connection (same room you joined with `join_room`).
Every event takes an optional ack callback that returns `{ ok, ... }` or `{ ok:false, error }`.

## Reply
`send_message` now accepts `replyToId` (id of any message in the same room, yours or someone else's).

The saved/broadcast message gets:
```json
"replyTo": { "id", "userId", "userName", "type", "text", "mimeType", "fileName" }
```
`text` is the first 140 characters of a text message (or the song title for music). It is `null` for no reply.

## React
Emit `react_message` with `{ roomId, messageId, emoji }`.

- One reaction per person per message. A different emoji switches yours; the same emoji again removes it.
- Server broadcasts `message_reaction` `{ roomId, messageId, reactions }` to the room.
- `reactions` is an array: `[{ userId, userName, emoji }]`. Every message has it (empty array if none).

## Delete (for everyone)
Emit `delete_message` with `{ roomId, messageId }`. Only the sender can delete their own message.

- Server broadcasts `message_deleted` `{ roomId, messageId, repliesUpdated: [messageIds] }`.
- Remove the message from the list on receipt.
- Replies that quoted it now have `replyTo.type === "deleted"` and empty text: show "This message was deleted" in the quote.
- Photos/videos/files of a deleted message are also removed from R2.

`room_state` and `/api/rooms/...` already include `replyTo` and `reactions`, so history loads with them.
Messages sent before this update have no `replyTo`/`reactions`: treat missing as `null` / `[]`.

## Edit (own text messages, 5 minutes)
Emit `edit_message` with `{ roomId, messageId, text }`.

- Only the sender, only `type: "text"`, and only within 5 minutes of `createdAt` (checked on the server).
  After that the ack is `{ ok:false, expired:true, error }`; delete is still allowed.
- Server broadcasts `message_edited` `{ roomId, messageId, text, editedAt, repliesUpdated: [messageIds] }`.
  Update the text, set `editedAt` (show an "Edited" label), and refresh the quote text in the listed replies.

## Delete several at once
Emit `delete_messages` with `{ roomId, messageIds: [...] }` (max 100, own messages only).
Ack: `{ ok, deleted: [ids], skipped: [ids] }`. Each deleted message is also broadcast as a normal `message_deleted`.

## Chat background (shared)
`room_state` / `/api/rooms` rooms now include `background`: `null`, `"color:#rrggbb"` or `"image:<url>"`.
Emit `set_chat_background` with `{ roomId, background }` (any member can change it; `null` resets to default).
Server broadcasts `chat_background` `{ roomId, background, by, byName }` to the room.
