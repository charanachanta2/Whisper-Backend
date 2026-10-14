# Friend-request decline, mentions, "add to your story"

## Declining a friend request (silent)
`POST /api/friends/requests/:id/decline` (only the person who received it).
- Nobody is notified. The sender keeps seeing the request as "pending" and cannot send the same request again.
- The request's notification disappears from the receiver's inbox (accepting removes it too).
- Notifications of kind `friend_request` now carry `requestId` so the app can accept/decline from the bell.

## Mentions
`POST /api/posts` and `POST /api/stories` accept `mentions: [userId]` (friends only). `@username` typed in a post caption is picked up too.
- Mentioned people get a `post_mention` / `story_mention` notification.
- They can always see the item, even when its audience is limited to other friends.
- Posts and stories come back with `mentionUsers: [{ id, username, name }]`.
- Stories also carry `canReshare` (true for a mentioned viewer who hasn't added it yet) and `sharedFrom` on reshares.

## Add to your story
`POST /api/stories/:id/reshare` (only for someone mentioned in that story, while it is live).
- Creates a copy on their own story for 24h, crediting the original author (`sharedFrom`).
- Returns 404 if the story is gone/not theirs to share, 409 if they already added it.
- The copy shares the original's file in R2, which is only deleted once nothing uses it any more.
