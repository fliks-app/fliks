# Spec: social (likes, follows, recommendations, profiles, stats)

Scope: likes, follows, recommendations, profiles, stats and the leave-social teardown. Authentication, error-body shapes and validation are in `auth.md` (cited "auth rule N"); user columns are in `users.md`; playlists (`PlaylistView`, `listVisibleForOwner`) are in `playlists.md`; history / recommendations / top-genres are in `playback-state.md`.

Routes: the likes controller (4 routes) + the social controller (16 routes) = 20 routes (`/api/likes*` and `/api/social*`). Both are guarded by `JwtOrApiKeyGuard` only, no `PoliciesGuard`, no CASL subject: every rule lives in the services. The "caller row" `me` is the user loaded by the auth extractor on every request (auth rule 14), so `me.shareDisabled`, `me.isAdmin`, `me.permissions` are always current.

Conventions used below: "void" = handler returns nothing, with the route's default status (POST 201, others 200) and an empty body. "404 U" = `{"message":"User #<id> not found","error":"Not Found","statusCode":404}` (auth rule 15). "400V" = validation body (auth rule 16). Every route: 401 for missing/invalid credentials (auth rule 14), guards before validation (auth rule 17), non-integer `:id`-style path params 400 `Validation failed (numeric string is expected)` (auth rule 18). `scope:'stream'` tokens are rejected on all of these (401).

## Routes

`SocialUser` = rule 20. `PublicProfile` = rule 33. `RecommendationItem` = `playback-state.md` rule 28. `LikedItem` = rule 5. Recommendation cards = rules 42-44. Timestamps are ISO-8601 with ms (`Date` serialisation).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/likes` | `JwtOrApiKeyGuard` (class); none | query `libraryId?` string (rule 4) | `LikedItem[]` (rule 5) | 401 | none |
| `GET /api/likes/state/:mediaId` | same | path `mediaId` int | `{media: boolean, seasonIds: number[], episodeIds: number[]}` (rule 6) | 400 pipe | none |
| `POST /api/likes` | same | body `LikeTargetDto`: `mediaId` int, `seasonId?` int, `episodeId?` int; unknown key 400 | 201 void | 400V; 404 `Media\|Season\|Episode #<id> not found` (rules 48, 56) | INSERT `likes` (idempotent) |
| `DELETE /api/likes` | same | body `LikeTargetDto` (a DELETE with a JSON body) | 200 void | 400V | DELETE `likes` |
| `GET /api/social/search` | `JwtOrApiKeyGuard` (class); none | query `q?` string | `SocialUser[]` (rule 21) | 401 | none |
| `GET /api/social/connectable` | same | query `q?` | `SocialUser[]` (rule 22) | 401 | none |
| `GET /api/social/recommendations` | same | query `libraryId?`, `limit?` (rule 38) | `RecommendationItem[]` (rule 39) | 400V on non-integer/negative `limit` (rule 38) | none |
| `POST /api/social/recommend` | same | body `RecommendContentDto`: `recipientId` int, `mediaId` int, `seasonId?` int, `episodeId?` int, `message?` string max 500 | 201 void | 400 `Cannot recommend to yourself` / `Sharing features are disabled`; 404 U (recipient hidden); 404 `Media\|Season\|Episode #<id> not found` (rules 48, 56); 400V | DELETE+INSERT `content_recommendations`; SSE `social.content_recommended` |
| `GET /api/social/recommendations/received` | same | query `includeDismissed?` (only the exact string `true` enables) | `ReceivedRecommendation[]` (rule 43) | 401 | none |
| `GET /api/social/recommendations/sent` | same | none | `SentRecommendation[]` (rule 44) | 401 | none |
| `POST /api/social/recommendations/:id/dismiss` | same | path `id` int | 201 void (always, even when nothing matched) | 400 pipe | UPDATE `content_recommendations` |
| `GET /api/social/requests` | same | none | `SocialUser[]` pending requests addressed to the caller (rule 15) | 401 | none |
| `POST /api/social/follow/:userId` | same | path `userId` int | 201 `{status: 'pending'\|'accepted'}` | 400 `Cannot follow yourself` / `Sharing features are disabled`; 404 U | INSERT `user_follows`; SSE `social.followed` / `social.follow_request` |
| `DELETE /api/social/follow/:userId` | same | path `userId` int | 200 void (always) | 400 pipe | DELETE `user_follows` (any status) |
| `POST /api/social/requests/:userId/accept` | same | path `userId` = the requester | 201 void | 404 `Follow request not found` | UPDATE `user_follows`; SSE `social.follow_accepted` |
| `POST /api/social/requests/:userId/reject` | same | path `userId` = the requester | 201 void (always) | 400 pipe | DELETE pending `user_follows` |
| `GET /api/social/users/:userId/followers` | same | path `userId` | `SocialUser[]` (rule 19) | 404 U | none |
| `GET /api/social/users/:userId/following` | same | path `userId` | `SocialUser[]` (rule 19) | 404 U | none |
| `GET /api/social/users/:userId/profile` | same | path `userId` | `PublicProfile` (rule 33) | 404 U (rule 26) | none |
| `GET /api/social/users/:userId/stats` | same | path `userId` | `UserStats` (rule 36) | 404 U (rule 35) | none |

Declaration order is irrelevant for routing here (no two routes overlap): `recommendations/received|sent` and `recommendations/:id/dismiss` differ in method or depth.

## Rules

### A. Likes

1. Likes are per-user bookmarks of a movie/series (`seasonId` and `episodeId` both absent), a season (`seasonId`) or an episode (`episodeId`); `mediaId` is always the parent title. Three partial unique indexes make a like idempotent per granularity: `UQ_likes_movie (userId, mediaId) WHERE seasonId IS NULL AND episodeId IS NULL`, `UQ_likes_season (userId, seasonId) WHERE seasonId IS NOT NULL`, `UQ_likes_episode (userId, episodeId) WHERE episodeId IS NOT NULL`; all FKs `ON DELETE CASCADE` (DDL in `server/migrations`).
2. `POST /likes`: `INSERT INTO likes ("userId","mediaId","seasonId","episodeId") VALUES ($me,$mediaId, $seasonId|NULL, $episodeId|NULL) ON CONFLICT DO NOTHING` (no conflict target: any of the three indexes). A falsy `seasonId`/`episodeId` (absent, `null`, `0`) is stored as NULL. Both `seasonId` and `episodeId` may be sent and are stored as given. An unknown id answers 400 or 404 (rule 48), and a season/episode not under `mediaId` or a media outside the caller's libraries answers 404 (rule 56). Response 201 empty.
3. `DELETE /likes`: `DELETE FROM likes WHERE "userId"=$me AND "mediaId"=$m AND ("seasonId"=$s | "seasonId" IS NULL) AND ("episodeId"=$e | "episodeId" IS NULL)`: the `IS NULL` branch is taken when the body value is falsy, so the body must repeat the exact granularity of the like. Always 200 empty (nothing matched is not an error).
4. `GET /likes` query `libraryId`: `libraryId ? +libraryId: undefined`; a non-numeric or `0` value therefore means "no filter" (NaN/0 are falsy in the service). Scope = the caller's accessible library ids (`libraries.md`: all ids when `isAdmin` or `manage:all`, else `library_user_access` rows).
5. `listLikes(userId, accessibleIds, {libraryId?, limit?})`: accessible list empty -> `[]`. Load the user's likes newest first (`createdAt DESC`) with `LIMIT limit ?? 60` **applied before** the ACL and `libraryId` filters, so a caller with many likes in inaccessible libraries gets fewer than 60. Drop a like whose media is missing or whose `media.libraryId` is not in `accessibleIds`; drop when `libraryId` is truthy and differs. Item: `{mediaId: number, mediaType: 'movie'|'series', title: string, posterUrl: string|null, fanartUrl: string|null, seasonId: number|null, episodeId: number|null, label: string|null, stillUrl: string|null}`. `label`: episode like -> `` `S${season.seasonNumber ?? '?'}E${episodeNumber}` `` plus ` · <episode title>` when the title is non-empty, where `season = like.season ?? episode.season ?? null`; else season like -> `<media title> · S<seasonNumber>`; else `null`. `stillUrl` = episode `stillUrl` or `null`. Tie-break for equal `createdAt`: `l.id ASC`; parity checks the order.
6. `GET /likes/state/:mediaId`: `{media, seasonIds, episodeIds}` from the caller's like rows of that media: `media` = some row has both `seasonId` and `episodeId` NULL; `seasonIds` = non-null `seasonId` of rows (row order, no sort); `episodeIds` likewise. No ACL and no existence check (unknown media -> `{media:false,seasonIds:[],episodeIds:[]}`). Row order: `ORDER BY l.id`.
7. `likedKeys(userId, mediaIds)` (internal, used by rule 42): the set of `mediaId:seasonId|'':episodeId|''` strings of the user's likes among `mediaIds`; empty input -> empty set.

### B. Follow graph

8. `user_follows(followerId, followingId, status 'pending'|'accepted' default 'accepted')`, unique pair `UQ_user_follows_pair`, FKs cascade. A follow of a **public** profile is stored `accepted` at once, with no consent from the target; a follow of a **private** profile is `pending` until accepted. Hence one-way accepted edges are normal.
9. `POST /follow/:userId` order: (1) `me.id == userId` -> 400 `Cannot follow yourself`; (2) `me.shareDisabled` -> 400 `Sharing features are disabled`; (3) target must exist AND `enabled = true` else 404 U; (4) `target.shareDisabled` -> 404 U (undiscoverable, no probing); (5) an edge `me -> target` already exists (any status) -> 201 `{status: <existing status>}` and **no event, no write**; (6) insert with status `accepted` when `target.profileVisibility = 'public'` else `pending`; (7) emit SSE to the target (rule 47); (8) 201 `{status}`.
10. Steps 5-6 are `INSERT... ON CONFLICT DO NOTHING` then a re-read, answered as step 5: two concurrent follows never produce a 500.
11. A pending request stays pending if the target later turns public; changing `profileVisibility` (either way) never touches existing edges (an accepted follower of a profile that becomes private keeps access). (no code path elsewhere updates `user_follows` status except rule 13)
12. `DELETE /follow/:userId`: `DELETE FROM user_follows WHERE "followerId"=$me AND "followingId"=$userId` (pending or accepted, also cancels a pending request); target need not exist; no event; 200 void.
13. `POST /requests/:userId/accept`: find edge `userId -> me` with status `pending`, none -> 404 `Follow request not found`; set `accepted`; emit `social.follow_accepted` to the requester; 201 void. Does not check that the requester is still enabled or not `shareDisabled`.
14. `POST /requests/:userId/reject`: `DELETE FROM user_follows WHERE "followerId"=$userId AND "followingId"=$me AND status='pending'`; no 404, no event; 201 void. An accepted follower cannot be removed by the followed user through this API (only the follower unfollows).
15. `GET /requests`: edges `* -> me` with status `pending`, joined to the follower row, mapped through `decorate` (rule 20); no `enabled`/`shareDisabled` filter; order `ORDER BY uf.id ASC`.
16. `areMutualFollowers(a,b)` (both directions accepted) has no caller (remote grants do not gate on follows, `remote.md` rule 26) and does not exist.
17. `requireUser(id)`: `SELECT... FROM users WHERE id=$1 AND enabled = true`, none -> 404 `User #<id> not found`. A disabled account is indistinguishable from a missing one.
18. `connectionsVisible(me, target)` = `me.id == target.id || target.profileVisibility = 'public' || me -> target is accepted`.
19. `GET /users/:userId/followers` and `/following`: `requireUser(userId)` (404 U), then `[]` (200) when `!connectionsVisible`, else the accepted edges (`* -> userId`, resp. `userId -> *`) joined to the other user, through `decorate`. The profile/stats gate and the `enabled` check apply (rule 49). Order `ORDER BY uf.id ASC`.
20. `decorate(me, users)` -> `SocialUser = {id: number, username: string, avatar: string|null, isFollowing: boolean, requested: boolean, followsYou: boolean}`: `isFollowing` = edge `me -> u` is `accepted`; `requested` = edge `me -> u` is `pending`; `followsYou` = edge `u -> me` is `accepted`. Empty input -> `[]`; output keeps the input order.

### C. Discovery

21. `GET /search?q=`: `me.shareDisabled` -> `[]`. Else users with `enabled = true AND shareDisabled = false AND id <> me.id`, plus `username ILIKE '%'||trim(q)||'%'` when the trimmed `q` is non-empty (no `q` = default roster), `ORDER BY lower(username), id LIMIT 30` (rule 52), decorated. `%` and `_` in `q` are NOT escaped (they act as wildcards). Private-profile users are included (that is how a follow request is made). The order is collation-independent.
22. `GET /connectable?q=`: `me.shareDisabled` -> `[]`. As rule 21 plus `(profileVisibility = 'public' OR id IN (<ids the caller follows with status accepted>))` (`IN (-1)` when none). Same reach as the playlist-collaborator rule (`playlists.md` rule 25) and `recommend` (rule 40).

### D. Visibility matrix (authz surface)

Facts used: `V` = viewer (`me`), `T` = target user, `follows` = edge `V -> T` is **accepted** (a pending edge never grants anything), `public` = `T.profileVisibility = 'public'` (enum `public|private`, default `private`, users.md rule 2), `optOut(X)` = `X.shareDisabled`.

| Question | Rule (exact) | Else |
|---|---|---|
| Does `T` exist for `V`? | `T.enabled` | 404 U |
| `profile`, `stats`: may `V` look at `T` at all? | `V = T`, or (`!optOut(T)` and `!optOut(V)`) | 404 U (never 403) |
| `follow`, `recommend`: may `V` act on `T`? | `V <> T`, `!optOut(V)` (400), `!optOut(T)` (404 U); `recommend` also needs `public` or `follows` (404 U) | see rules 9, 40 |
| `search`, `connectable`: who is listed? | `V` not opted out; listed = enabled and not opted out and not `V`; `connectable` further needs `public` or `follows` | `[]` |
| `followers`, `following` lists | `V = T` or `public` or `follows` | `[]` (200) |
| Profile content (playlists, tastes,...) | `canSeeContent` = `V = T` or `public` or `follows` | header only, counts 0 (rule 31) |
| Profile `followerCount`/`followingCount` | shown when `canSeeContent`, else `0` | `0` |
| Playlists section | `public` playlists of `T`; plus `followers` ones when `V = T` or `follows` (`includeFollowers`); `private` ones never | `playlists.md` rule 18 |
| Stats | `V = T`, or (`T.shareStats` and (`public` or `follows`)) | 404 U |
| Per-section flags (`tastes`, `recommendations`, `recentlyWatched`, `likes`, `stats`) | `V = T` or `T.shareTastes` / `shareRecommendations` / `shareWatchHistory` / `shareLikes` / `shareStats` (all default `false`) | section empty, `shown.<x> = false` |
| Library scoping of shown content | every list is filtered by the **viewer's** accessible library ids, never the target's | item dropped |

23. A private profile's non-follower (and a pending requester) sees only `{id, username, avatar, isFollowing, requested, followsYou, isSelf, visibility}`; username and avatar of every enabled, non-opted-out member are therefore public to every member by design.
24. "No probe": `shareDisabled` members answer exactly like missing ones on `follow`, `recommend`, `profile`, `stats`; they are also hidden on `followers`/`following` (rule 49).

### E. Profile (`GET /users/:userId/profile`)

25. Used by clients for every member page (`GET /api/users/:id` is self or `users.manage` only, so this route is the only cross-user read; `users.md` rule 5). It returns the `PublicProfile` JSON below with the same nulls and empties.
26. Order: `requireUser(userId)` (404 U), `isSelf = me.id == userId`; `!isSelf && (T.shareDisabled || me.shareDisabled)` -> 404 U.
27. Header (always present): `{id, username, avatar: string|null, isFollowing, requested, followsYou, isSelf, visibility: 'public'|'private', followerCount, followingCount}`. `followerCount` = count of accepted edges `* -> T`, `followingCount` = accepted `T -> *`, over the members `graph::listable` keeps (rule 59). For `isSelf`: `isFollowing = false`, `requested = false`, `followsYou = false`.
28. `canSeeContent = isSelf || public || isFollowing` (accepted). When false: header with `followerCount = 0`, `followingCount = 0`, `shown` all `false`, and `playlists`, `topGenres`, `recommendations`, `recentlyWatched`, `likes` all `[]`.
29. When true: `includeFollowers = isSelf || isFollowing`; `viewerAccessible` = accessible library ids of the viewer; `shown = {playlists: true, tastes: isSelf || T.shareTastes, recommendations: isSelf || T.shareRecommendations, recentlyWatched: isSelf || T.shareWatchHistory, likes: isSelf || T.shareLikes, stats: isSelf || T.shareStats}`. `shown.stats` is only a UI hint: the stats themselves come from the stats route (rule 35).
30. Sections, fetched concurrently, each skipped (empty) unless its flag is true: `playlists` = `listVisibleForOwner(T, V, includeFollowers)` (`playlists.md` rule 18; note a viewer who is `T` sees only public and followers playlists here, role `viewer`); `topGenres` = `getTopGenres(T)` default limit 8 -> `{genre: string, weight: number}[]` (`playback-state.md` rule 29; scoped to the viewer's libraries, rule 50); `recommendations` = `getRecommendations(T, viewerAccessible, 15)` (`playback-state.md` rules 21-28) with `becauseTitle` forced to `''` on every item (it names a title from the target's unscoped history); `recentlyWatched` = `getHistory(T, page 1, limit 12, viewerAccessible).data` (`WatchHistoryItem[]`, `playback-state.md` rule 13); `likes` = `listLikes(T, viewerAccessible, {limit: 24})` (rule 5).
31. All sections are computed with the **target's** data and the **viewer's** library ACL; an empty `viewerAccessible` yields empty `recommendations`, `recentlyWatched`, `likes`.
32. The profile is built from plain objects (no entity serialisation).
33. `PublicProfile` JSON = header (rule 27) + `shown: {playlists, tastes, recommendations, recentlyWatched, likes, stats: boolean}` + `playlists: PlaylistView[]` + `topGenres` + `recommendations: RecommendationItem[]` + `recentlyWatched: WatchHistoryItem[]` + `likes: LikedItem[]`.

### F. Stats (`GET /users/:userId/stats`)

34. This is the second consumer of the stats aggregation that `users.md` rule 28 specifies for the admin route. There is ONE implementation (`user_stats(user_id)`, SQL below). The response shape is exactly `users.md` rule 28.
35. Gate (before aggregating): `requireUser` (404 U); `!isSelf && (T.shareDisabled || me.shareDisabled)` -> 404 U; for non-self: `iFollow` = accepted edge `me -> T`, `canSee = public || iFollow`; `!T.shareStats || !canSee` -> 404 U. Self always passes.
36. `UserStats` = `{playback: {totalWatchTimeSeconds: int, moviesWatched: int, seriesStarted: int, episodesWatched: int, lastPlayedAt: ISO string|null}, requests: {pending, approved, declined: int}, activity: {lastActiveAt: ISO|null, memberSince: ISO}}`. `totalWatchTimeSeconds = Math.round(SUM)`; `lastPlayedAt` is `MAX("lastPlayedAt")` formatted `YYYY-MM-DDTHH:MM:SS.mmmZ`; `lastActiveAt` = `users.lastLogin`, `memberSince` = `users.createdAt`. Exposes the target's request counts to any viewer allowed by rule 35; `lastActiveAt` is omitted for a non-self viewer (rule 58).

### G. "Popular among people I follow" (`GET /recommendations`)

37. `followingIds` = accepted edges `me -> *`; empty -> `[]`; `accessible` = caller's library ids, empty -> `[]`; `libs = [libraryId]` when `libraryId` truthy and in `accessible`, else `accessible` (an inaccessible `libraryId` silently widens to all accessible, unlike `playback-state.md` rule 1 which narrows to `[]`).
38. Query parsing: `libraryId ? +libraryId: undefined` (NaN, `0` -> no filter); `limit ? Math.min(+limit, 50): 20`. `limit=0` -> `Math.min(0,50)=0` -> `LIMIT 0` -> `[]`. A non-numeric, negative or fractional `limit` is 400V and a `limit` above 50 is clamped to 50.
39. Rows: media completed by at least one followed user, within `libs`, not touched by the caller (no `playback_states` row of the caller for any item of that media, completed or not), ranked by number of distinct followed users then newest media id; loaded media are mapped to `RecommendationItem` in row order, a row whose media does not load is dropped: `{media: {id, title, type, year, posterUrl, fanartUrl, additionalFanartUrls: string[] (null -> []), genres: string[] (null -> []), available: true}, becauseTitle: '', score: 0}` (`available` is always `true`, `score` always `0`). Only followed users with `shareWatchHistory` count (rule 51).

### H. Member-to-member recommendations

40. `assertConnectable(me, T)`: `!T.shareDisabled && (T public || me -> T accepted)` else 404 `User #<T.id> not found` (hidden recipient is not probeable).
41. `POST /recommend` order: (1) `me.id == recipientId` -> 400 `Cannot recommend to yourself`; (2) `me.shareDisabled` -> 400 `Sharing features are disabled`; (3) `requireUser(recipientId)` (404 U); (4) `assertConnectable` (404 U); (5) media row by id (library ACL of the sender, rule 56) else 404 `Media #<mediaId> not found`; (6) delete the previous row with the same `(sender, recipient, media, season|NULL, episode|NULL)` so a re-recommendation resurfaces with a fresh `createdAt`/id; (7) insert `{sender, recipient, media, season: seasonId ? id: NULL, episode: episodeId ? id: NULL, message: message?.trim || NULL, dismissedAt: NULL}`; (8) emit SSE to the recipient (rule 47); (9) 201 void. Steps 6-7 are two statements, not transactional. `seasonId`/`episodeId` are checked against the media (an unknown id is 400/404, rule 48; a foreign one is 404, rule 56). `message` is a string of at most 500 chars, trimmed; empty after trim stores NULL.
42. `RecommendationCard` (shared half): `{id: number, message: string|null, createdAt: ISO, mediaId, mediaType: 'movie'|'series', title, posterUrl: string|null, fanartUrl: string|null, seasonId: number|null, episodeId: number|null, label: string|null, stillUrl: string|null}`; `label`/`stillUrl` as rule 5 (with `r.season ?? r.episode.season`); a row is dropped (not an error) when its media is missing or not in the **reading** user's accessible libraries.
43. `GET /recommendations/received`: caller's accessible ids empty -> `[]`; rows `recipientId = me` (plus `dismissedAt IS NULL` unless `includeDismissed === 'true'`), `ORDER BY createdAt DESC LIMIT 60` applied before the ACL filter, tie-break `id ASC` as in rule 5; item = `RecommendationCard` + `sender: {id, username, avatar: string|null}` + `liked: boolean` (rule 7 key `mediaId:seasonId|'':episodeId|''` is in the caller's likes). Sender `shareDisabled`/`enabled` are not consulted (a sender who later opts out loses their rows via the teardown, rule 46).
44. `GET /recommendations/sent`: same guard and `LIMIT 60` rule over `senderId = me`; item = `RecommendationCard` + `recipient: {id, username, avatar: string|null}`; no `liked`.
45. `POST /recommendations/:id/dismiss`: `UPDATE content_recommendations SET "dismissedAt" = now WHERE id = $id AND "recipientId" = $me AND "dismissedAt" IS NULL`; idempotent, never 404, a foreign id is a silent no-op (no existence oracle); 201 void.

### I. Leaving social (moved from users)

46. `users.md` rule 24 (`PUT /users/:id` with `shareDisabled` going `false -> true`) calls this teardown: a function of the social/playlists domain (the six statements, verbatim in SQL), run after the user row is saved, in the order given, in one transaction with the related write (rule 53). Effects: the user leaves the follow graph in both directions, their saves and collaborator shares disappear, their own playlists are unshared and made private, recommendations they sent or received disappear. Likes, `recommendation_dismissals`, `playlist_items.addedById`, the profile flags and `profileVisibility` are untouched; turning `shareDisabled` back to `false` restores nothing. No SSE event is sent to the affected members. `UPDATE playlists SET visibility = 'private'` bumps `playlists."updatedAt"` through the updated-at trigger (`1786500000000_updated_at_trigger.sql`), so made-private playlists move up in the owner's home row; the function must not set `"updatedAt"` itself.

## SQL

Tables: `likes`, `user_follows`, `content_recommendations`, `users`, `media`, `item_groups`, `items`, `playback_states`, `requests`, `library_user_access`. DDL is in `server/migrations`. The database calls written as equivalent SQL; `$me` = caller id.

- User gate: `SELECT * FROM users WHERE id = $1 AND enabled = true`.
- Accepted-edge test: `SELECT EXISTS (SELECT 1 FROM user_follows WHERE "followerId" = $1 AND "followingId" = $2 AND status = 'accepted')`.
- Decorate: `SELECT * FROM user_follows WHERE "followerId" = $me AND "followingId" = ANY($ids)` and `SELECT * FROM user_follows WHERE "followerId" = ANY($ids) AND "followingId" = $me AND status = 'accepted'`.
- Follow: `SELECT * FROM user_follows WHERE "followerId" = $me AND "followingId" = $t LIMIT 1`; `INSERT INTO user_follows ("followerId","followingId",status) VALUES ($me,$t,$status)` (rule 10: add `ON CONFLICT ("followerId","followingId") DO NOTHING`).
- Unfollow: `DELETE FROM user_follows WHERE "followerId" = $me AND "followingId" = $t`. Reject: `DELETE FROM user_follows WHERE "followerId" = $r AND "followingId" = $me AND status = 'pending'`. Accept: `SELECT... WHERE "followerId" = $r AND "followingId" = $me AND status = 'pending'` then `UPDATE user_follows SET status = 'accepted', "updatedAt" = now WHERE id = $id`.
- Pending list: `SELECT uf.*, u.* FROM user_follows uf JOIN users u ON u.id = uf."followerId" WHERE uf."followingId" = $me AND uf.status = 'pending' ORDER BY uf.id`. Followers: same with `uf."followingId" = $t AND uf.status = 'accepted'`, joined on `"followerId"`; following: `uf."followerId" = $t`, joined on `"followingId"`.
- Search: `SELECT u.* FROM users u WHERE u.enabled = true AND u."shareDisabled" = false AND u.id <> $me [AND u.username ILIKE $q] ORDER BY u.username ASC LIMIT 30` (`$q` = `'%' || trim(q) || '%'`). Connectable: first `SELECT "followingId" FROM user_follows WHERE "followerId" = $me AND status = 'accepted'`, then the search query plus `AND (u."profileVisibility" = 'public' OR u.id = ANY($ids))` (`$ids = {-1}` when empty).
- Profile counts: `SELECT COUNT(*) FROM user_follows WHERE "followingId" = $t AND status = 'accepted'` and `... WHERE "followerId" = $t AND status = 'accepted'`; viewer edge `SELECT * FROM user_follows WHERE "followerId" = $me AND "followingId" = $t LIMIT 1`; `followsYou` via the accepted-edge test `($t, $me)`.
- Likes: `INSERT INTO likes ("userId","mediaId","seasonId","episodeId") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`; unlike: `DELETE FROM likes WHERE "userId" = $1 AND "mediaId" = $2 AND "seasonId" IS NULL|= $3 AND "episodeId" IS NULL|= $4`; keys: `SELECT l."mediaId", l."seasonId", l."episodeId" FROM likes l WHERE l."userId" = $1 AND l."mediaId" = ANY($2)`; state: `SELECT l."seasonId", l."episodeId" FROM likes l WHERE l."userId" = $1 AND l."mediaId" = $2 ORDER BY l.id`.
- Liked items: `SELECT l.id, l."seasonId", l."episodeId", m.id, m.type, m.title, m."posterUrl", m."fanartUrl", m."libraryId", s."number", e."number", e.title, e."stillUrl", es."number" FROM likes l LEFT JOIN media m ON m.id = l."mediaId" LEFT JOIN item_groups s ON s.id = l."seasonId" LEFT JOIN items e ON e.id = l."episodeId" LEFT JOIN item_groups es ON es.id = e."groupId" WHERE l."userId" = $1 ORDER BY l."createdAt" DESC, l.id ASC LIMIT $limit` (ACL and `libraryId` filters applied after the LIMIT, rule 5).
- Followed users' popular media, verbatim (`$1` followed ids int[], `$2` library ids int[], `$3` caller id, `$4` limit):
  ```sql
  SELECT pi."mediaId" AS "mediaId", COUNT(DISTINCT ps."userId")::int AS cnt
  FROM playback_states ps
  JOIN items pi ON pi.id = ps."itemId"
  JOIN media m ON m.id = pi."mediaId"
  WHERE ps."userId" = ANY($1)
    AND ps.completed = true
    AND m."libraryId" = ANY($2)
    AND NOT EXISTS (
      SELECT 1 FROM playback_states mine JOIN items mi ON mi.id = mine."itemId"
      WHERE mine."userId" = $3 AND mi."mediaId" = pi."mediaId"
)
  GROUP BY pi."mediaId"
  ORDER BY cnt DESC, pi."mediaId" DESC
  LIMIT $4
  ```
  followed by `SELECT m.id, m.title, m.type, m.year, m."posterUrl", m."fanartUrl", m."additionalFanartUrls", m.genres FROM media m WHERE m.id = ANY($ids)`. The ordering is total (`cnt DESC, mediaId DESC`).
- Recommend: `DELETE FROM content_recommendations WHERE "senderId" = $1 AND "recipientId" = $2 AND "mediaId" = $3 AND ("seasonId" = $4 | "seasonId" IS NULL) AND ("episodeId" = $5 | "episodeId" IS NULL)`; `INSERT INTO content_recommendations ("senderId","recipientId","mediaId","seasonId","episodeId",message,"dismissedAt") VALUES ($1,$2,$3,$4|NULL,$5|NULL,$6|NULL,NULL)`; media check `SELECT * FROM media WHERE id = $1`.
- Received: `SELECT cr.*, u.id, u.username, u.avatar, m.*, s.*, e.*, es.* FROM content_recommendations cr JOIN users u ON u.id = cr."senderId" LEFT JOIN media m... LEFT JOIN item_groups s... LEFT JOIN items e... LEFT JOIN item_groups es ON es.id = e."groupId" WHERE cr."recipientId" = $me [AND cr."dismissedAt" IS NULL] ORDER BY cr."createdAt" DESC, cr.id ASC LIMIT 60`. Sent: same with `cr."senderId" = $me`, joined to the recipient. Dismiss: `UPDATE content_recommendations SET "dismissedAt" = now, "updatedAt" = now WHERE id = $1 AND "recipientId" = $2 AND "dismissedAt" IS NULL`.
- Stats (`$1` target id, `'movie'`/`'series'` the `media.type` values):
  ```sql
  SELECT COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0) AS "totalWatchTimeSeconds",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'movie' THEN it."mediaId" END) AS "moviesWatched",
         COUNT(DISTINCT CASE WHEN ps.completed AND media.type = 'series' THEN it."mediaId" END) AS "seriesStarted",
         COUNT(DISTINCT CASE WHEN ps.completed AND it."groupId" IS NOT NULL THEN it.id END) AS "episodesWatched",
         MAX(ps."lastPlayedAt") AS "lastPlayedAt"
  FROM playback_states ps JOIN items it ON it.id = ps."itemId" LEFT JOIN media ON media.id = it."mediaId"
  WHERE ps."userId" = $1
  ```
  and: `SELECT r.status AS status, COUNT(*) AS count FROM requests r WHERE r."userId" = $1 GROUP BY r.status` (map `pending`, `approved`, `declined`; absent = 0). The `SUM` is a float, `COUNT` values bigint -> numbers; `Math.round` on the sum.
- Teardown, verbatim (`$1` = the user id, in this order):
  ```sql
  DELETE FROM user_follows WHERE "followerId" = $1 OR "followingId" = $1
  DELETE FROM playlist_saves WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "userId" = $1
  DELETE FROM playlist_shares WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1)
  UPDATE playlists SET visibility = 'private' WHERE "ownerId" = $1 AND visibility <> 'private'
  DELETE FROM content_recommendations WHERE "senderId" = $1 OR "recipientId" = $1
  ```

## Events

SSE, delivered to **one user only** (`emitToUser`), after the DB write succeeded, fire-and-forget (not part of any transaction, no replay, no retry). Wire shapes are rows 37-39 of `events-hub.md`:

| Event | Audience | Payload | Emitted by |
|---|---|---|---|
| `social.followed` | the followed user, when the new edge is `accepted` (target public) | `{userId: <follower id>, username, avatar: string\|null}` | `follow` |
| `social.follow_request` | the followed user, when the new edge is `pending` (target private) | same | `follow` |
| `social.follow_accepted` | the requester | `{userId: <accepter id>, username, avatar}` | `acceptRequest` |
| `social.content_recommended` | the recipient | `{userId: <sender id>, username, avatar, mediaTitle: string}` | `recommend` |

47. No event for: an existing edge returned by `follow` (rule 9 step 5), `unfollow`, `reject`, `dismiss`, likes, the teardown. Types are in the closed `SseEvent` union; the client switch is `client/src/app/core/services/sse.service.ts`. Events are emitted in process on the hub.

### J. Cross-cutting rules

48. Non-integer or out-of-range ids and filters, `libraryId`, unknown media/season/episode ids on likes and `POST /recommend`, unknown profile/user ids, null on non-nullable fields, `GET /recommendations` `limit` (rule 38): 400 (standard body) or 404 (`Media|Season|Episode #<id> not found` / 404 U), never 500.
49. `GET /users/:userId/followers` and `/following` apply the same gate as `profile`/`stats` (section D): a viewer or target with `shareDisabled` (non-self) answers 404 U, a disabled target 404 U, and listed users with `enabled = false` are omitted.
50. Profile `topGenres` is computed over the target's history restricted to the viewer's accessible library ids (as `recentlyWatched` and `likes` are).
51. `GET /recommendations` ("popular among people I follow") counts only followed users whose `shareWatchHistory` is true (the target's own opt-in, as for `recentlyWatched`).
52. `search` and `connectable` order by `lower(username) ASC, id ASC` before `LIMIT 30`, so the returned 30 do not depend on the database collation; parity compares the arrays order-insensitively.
53. The leave-social teardown (rule 46, six statements) runs in the same transaction as the `PUT /users/:id` write that triggers it (`users.md` rule 24); a teardown failure rolls the user update back.
54. Every list ends with `id ASC` (or the documented DESC key then `id`): follow requests, followers, following, likes state, search/connectable (rule 52), likes and recommendation cards (`createdAt DESC, id ASC`, rules 5, 43).
55. Relation-id fields stay absent when the FK is null (e.g. `libraryId`, `episodeId` keys of embedded media/likes rows); this applies to the embedded media shape only.
56. `POST /likes` and `POST /recommend` answer 404 `Media #<id> not found` for a media outside the caller's accessible libraries, and 404 `Season #<id> not found` / `Episode #<id> not found` for a season or episode that is not under `mediaId` (episode via its season), exactly as for unknown ids: nothing is written and nothing tells a foreign id from a missing one. Checked in that order (media, season, episode) before any write. `DELETE /likes` is unchanged.
57. Opted-out (`shareDisabled`) and disabled (`enabled = false`) members never appear in a social list: `requests`, `followers`, `following` and the `sender`/`recipient` of `recommendations/received` and `/sent` omit them (one predicate, `graph::listable`: the rule 49 filter extended to opted-out members). `search`/`connectable` exclude them (rules 21-22).
58. `GET /social/users/:userId/stats` keeps the request counts under `shareStats` (rule 35) but omits `activity.lastActiveAt` (last login, presence data) when the viewer is not the target; the key is absent, `memberSince` stays. The admin `GET /users/:id/stats` and a self read keep it. The client's profile Statistics tab does not read it.
59. The profile `followerCount`/`followingCount` (rule 27) count only the accepted edges whose other member passes `graph::listable` (enabled, not opted out), so they equal the lengths of the `followers`/`following` lists (rule 57).

## Settings keys

none

## Jobs/timers

none

## Vectors/parity

No fixture set for this domain (`recommend` belongs to `playback-state.md`; the `followingRecommendations` SQL is covered by parity on the seed). Rust unit tests (table-driven): the visibility matrix of section D (every row x {self, public, private+accepted, private+pending, private+none, T opted out, V opted out}); `label` / `liked` key composition; the `limit` parsing of rule 38; the follow status decision and idempotence.

Parity scenarios: `server/parity/scenarios/likes/` (14: `list`, `list-acl`, `list-library-filter` incl. non-numeric `libraryId`, `state`, `like-movie` / `like-season` / `like-episode` / `like-zero-ids`, `unlike` (granularity must match), `validation` (400), `unauthenticated` (401), `bad-mediaid` (400), `like-unknown-media` (400/404), `like-foreign-target` (404)) and `server/parity/scenarios/social/` (65, `as` in `admin|user|readonly|other`): search (`search-default-roster`, `search-q` with the ILIKE wildcard `%`, `search-order-collation` with mixed-case usernames, `search-opted-out-viewer`, `search-opted-out-listed`, `connectable`), follows (`follow-public` 201 `accepted`, `follow-private` 201 `pending`, `follow-twice`, `follow-self` 400, `follow-opted-out-target` 404, `follow-opted-out-viewer` 400, `follow-unknown` 404, `follow-unauthenticated`, `unfollow`, `requests-list`, `requests-disabled-requester`, `accept` then 404 `Follow request not found` on the second call, `reject`), lists (`followers-public`, `followers-opted-out`, `followers-opted-out-viewer`, `followers-private-nonfollower` `[]`, `followers-disabled-follower`, `followers-unknown`, `following-private-follower`, `following-disabled-user`), profile (`profile-self`, `-public`, `-private-nonfollower` empty shape with counts 0, `-private-follower`, `-opted-out-target` 404, `-disabled-target` 404, `-counts-disabled-follower`, `-all-sections`, one `-sections-flag-share*` per flag, `-viewer-acl`, `-topgenres-scoped`), stats (`stats-self`, `-shared`, `-not-shared` 404, `-private` 404, `-opted-out`, `-last-login-omitted`), recommendations (`recommendations-following`, `-bad-limit`, `-sharewatchhistory-off`, `-unauthenticated`, `recommend`, `recommend-self` 400, `-hidden-recipient` 404, `-unknown-media` 404, `-unknown-ids`, `-foreign-target` 404, `-acl`, `-opted-out-sender`, `-private-followed`, `-twice` replaced card, `-validation` message 501 chars, `dismiss-foreign` 201 no-op) and `leave-social` (via `PUT /api/users/:id {shareDisabled:true}`: follows, saves, shares, recommendations gone, playlists private, then `GET /api/playlists/:id` shows the bumped `updatedAt`). Events (4 SSE types) are asserted by Rust tests against the hub, not by HTTP parity.

Seed needs: users `admin`, `user`, `readonly`, `other` with mixed `profileVisibility`, one `shareDisabled` user, one disabled user, `share*` flag combinations, an accepted and a pending edge, a viewer lacking one library, likes at all three granularities, recommendations (dismissed and not), `playback_states` rows for the followed-users query.
