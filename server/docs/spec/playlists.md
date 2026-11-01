# Spec: playlists

Authentication, CASL, error-body shapes and validation are in `auth.md` (cited "auth rule N"); the social graph (`user_follows`, profile visibility) and the leave-social teardown are in `social.md`; the playback side of auto-remove is in `heartbeat.md` / `playback-state.md`.

Scope: the 15 routes under `/api/playlists`. Class-level guards `JwtOrApiKeyGuard, PoliciesGuard`. Per-playlist authorisation is entirely in the service (rules 2-5).

Conventions: "void" = the route answers its default status (POST 201, others 200) with an empty body. "404 P" = `{"message":"Playlist #<id> not found","error":"Not Found","statusCode":404}`. "403 role" = `{"message":"Insufficient playlist role","error":"Forbidden","statusCode":403}`. Error bodies: auth rule 15; validation 400 (400V): auth rule 16; guards before pipes: auth rule 17; non-integer path param 400 `Validation failed (numeric string is expected)`: auth rule 18; 401: auth rule 14. `scope:'stream'` tokens are rejected on all routes (401).

## Routes

`PlaylistView` = rule 10. `PlaylistItemView` = rule 14. `Member[]` = rule 17. Dates ISO-8601 with ms. "min role" refers to rule 4.

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/playlists` | `JwtOrApiKeyGuard`, `PoliciesGuard` (class); `can(Read, Playlist)` (always true, rule 3) | none | `PlaylistView[]` owned + shared + saved, by name (rule 9) | 401 | none |
| `POST /api/playlists` | same; `can(Create, Playlist)` | `CreatePlaylistDto`: `name` string max 255; `autoRemoveWatched?`, `autoDownload?`, `autoPlay?` booleans; unknown key (e.g. `visibility`) 400 | 201 `PlaylistView` (rule 20) | 400V | INSERT `playlists` |
| `GET /api/playlists/:id` | same; `can(Read, Playlist)` | path `id` | `PlaylistView` (rule 11) | 404 P | none |
| `PATCH /api/playlists/:id` | same; `can(Update, Playlist)`; min role administrator | `UpdatePlaylistDto`: `name?` max 255, `autoRemoveWatched?`, `autoDownload?`, `autoPlay?` booleans, `visibility?` `'private'\|'followers'\|'public'` | `PlaylistView` | 400V; 400 `Sharing features are disabled`; 404 P; 403 role | UPDATE `playlists` |
| `DELETE /api/playlists/:id` | same; `can(Delete, Playlist)`; owner only | path `id` | 200 void | 404 P; 403 `Only the owner can delete a playlist` | DELETE `playlists` (cascade) |
| `GET /api/playlists/:id/items` | same; `can(Read, Playlist)`; min role viewer | path `id` | `PlaylistItemView[]` (rule 14) | 404 P | none |
| `POST /api/playlists/:id/items` | same; `can(Update, Playlist)`; min role editor | `AddPlaylistItemDto`: `episodeId?` \| `seasonId?` \| `mediaId?` ints (precedence in that order) | 201 `{added: number}` | 400V; 400 `errors.playlist_add_target_required`; 400 `errors.media_already_in_playlist`; 404 P; 403 role; 404 `Episode\|Media\|Series #<id> not found` | INSERT `playlist_items`; UPDATE `playlists."updatedAt"` |
| `DELETE /api/playlists/:id/items/:itemId` | same; `can(Update, Playlist)`; min role editor | path `id`, `itemId` | 200 void | 404 P; 403 role; 404 `Playlist item #<itemId> not found` | DELETE `playlist_items`; UPDATE `playlists."updatedAt"` |
| `DELETE /api/playlists/:id/items/by-media/:mediaId` | same; min role editor | path `id`, `mediaId` | 200 `{removed: number}` | 404 P; 403 role | DELETE `playlist_items`; UPDATE `playlists."updatedAt"` only when `removed > 0` |
| `PUT /api/playlists/:id/items/order` | same; min role editor | `ReorderPlaylistItemsDto`: `itemIds` int[] | 200 void | 400V; 400 `itemIds must list every item in the playlist exactly once`; 404 P; 403 role | UPDATE `playlist_items.position` x N + `playlists."updatedAt"` in one transaction |
| `GET /api/playlists/:id/members` | same; `can(Read, Playlist)`; min role viewer | path `id` | `Member[]` (rule 17) | 404 P | none |
| `POST /api/playlists/:id/members` | same; `can(Update, Playlist)`; min role administrator | `AddPlaylistMemberDto`: `userId` int, `role` `'viewer'\|'editor'\|'administrator'` | 201 `Member[]` | 400V; 400 `Sharing features are disabled` / `Cannot change your own role` / `The owner is already a member`; 404 `User #<id> not found`; 403 `You can only add public members or members you follow`; 404 P; 403 role | UPSERT `playlist_shares` |
| `DELETE /api/playlists/:id/members/:userId` | same; `can(Update, Playlist)`; min role administrator | path `id`, `userId` | 200 `Member[]` | 400 `Cannot change your own membership` / `Cannot remove the owner`; 404 P; 403 role | DELETE `playlist_shares` |
| `POST /api/playlists/:id/save` | same; `can(Read, Playlist)`; min role viewer | path `id` | 201 void | 400 `Sharing features are disabled` / `You already own this playlist`; 404 P | INSERT `playlist_saves` (idempotent) |
| `DELETE /api/playlists/:id/save` | same; `can(Read, Playlist)` | path `id` | 200 void (always) | 400 pipe | DELETE `playlist_saves` |

Declaration order: `PUT items/order` and `DELETE items/by-media/:mediaId` are declared before `DELETE items/:itemId`; no clash (different method or depth).

## Rules

### A. Model and access control

1. Tables: `playlists(name varchar(255), ownerId, autoRemoveWatched bool=false, autoPlay bool=false, autoDownload bool=false, visibility enum 'private'|'followers'|'public' default 'private', coverImageUrl varchar(512) null)`; `playlist_items(playlistId, itemId FK items ON DELETE CASCADE, position int, addedById null ON DELETE SET NULL)` with `UQ_playlist_items_item (playlistId, itemId)` (no unique on `position`; the `itemId` of the wire in rule 14 is the row id, not this column); `playlist_shares(playlistId, userId, role enum 'viewer'|'editor'|'administrator' default 'viewer')` unique `(playlistId, userId)`; `playlist_saves(userId, playlistId)` unique pair. Every FK cascades on delete except `addedById`. The owner is the column `ownerId`, never a share row, so the owner cannot be removed or demoted structurally. `coverImageUrl` is never written by the API (always `null`). The DDL is in `server/migrations`.
2. Roles rank `viewer 1 < editor 2 < administrator 3`; `owner` is implicit full access and is reported as the string `'owner'` in `role` fields.
3. The class-level policies (`Read|Create|Update|Delete` on `Playlist`) are unconditional grants for every authenticated user, `manage:all` included (auth rules 20, 24, 26), so the policy check never rejects after authentication: only the authenticated extractor is needed (a `readonly` role can create and edit its own playlists).
4. `assertRole(user, id, min)` returns `{playlist, role}` and decides every authorisation: (1) no playlist row -> 404 P; (2) `playlist.ownerId == user.id` -> role `'owner'`; (3) **only when `min = viewer`**: `visibility = 'public'` -> role `viewer` (a share row is not consulted); `visibility = 'followers'` and an accepted `user -> owner` edge exists -> role `viewer`; (4) share row for `(playlist, user)`: none -> 404 P (non-members never learn the playlist exists); `rank(share.role) < rank(min)` -> 403 role; else the share's role. Visibility therefore never grants write access, and a caller with no share who fails step 3 gets 404, not 403, on write routes.
5. Role reporting: a caller holding an `editor` or `administrator` share on a `public` playlist (or a `followers` playlist they follow) receives that share role in `GET /playlists/:id` and in every `PlaylistView` built through `findOneForUser` (create, patch), as in the list route (rule 9); rules 41 and 47. `assertRole` itself returns `viewer` at step 3 when `min = viewer`; write routes pass `min >= editor`, which skips step 3.
6. Resulting matrix (O owner, A/E/V share role, pub = `public` visibility, fol = `followers` visibility with an accepted follow of the owner, none = no share):

| Route | Min role | O | A | E | V | none + pub / fol | none otherwise |
|---|---|---|---|---|---|---|---|
| `GET:id`, `GET:id/items`, `GET:id/members`, `POST|DELETE:id/save` | viewer | ok | ok | ok | ok | ok (role `viewer`) | 404 P |
| `DELETE:id` | viewer, then owner check | ok | 403 `Only the owner can delete a playlist` | 403 same | 403 same | 403 same (readable, not owner) | 404 P |
| `PATCH:id`, `POST|DELETE:id/members[/:userId]` | administrator | ok | ok | 403 role | 403 role | 404 P | 404 P |
| `POST:id/items`, `DELETE:id/items/...`, `PUT:id/items/order` | editor | ok | ok | ok | 403 role | 404 P | 404 P |

7. `shareDisabled` (users.md): an opted-out caller cannot `save` (400, before the role lookup, so also on a playlist they cannot read), cannot `addMember` (400, after the role check), cannot set a non-private `visibility` (400); reading/writing playlists they already own or are a member of is unaffected. The teardown that makes everything private is `social.md` rule 46 (rule 40 below).
8. Library ACL: every read that shows media (`items`, posters, counts, `addItem`) is scoped to the **caller's** accessible library ids (all ids when `isAdmin` or `manage:all`, else `library_user_access`); items in libraries the caller cannot access are omitted for shared members too. Rows are never removed by this filter.

### B. Reads

9. `GET /playlists`: the union of owned playlists (`role 'owner'`, `saved false`), playlists shared with the caller (their share role, `saved false`) and playlists the caller saved (`role 'viewer'`, `saved true`); a playlist in several sets appears once with precedence owner > share > save. Empty union -> `[]`. Each entry is a `PlaylistView` (rule 10) with `itemCount`/`posters` computed under the caller's ACL (rule 12), sorted by `name` in byte order, then `id`. A saved playlist the saver can no longer read (the owner made it private) is dropped from the list (rule 42).
10. `PlaylistView` = `{id: number, name: string, ownerId: number, role: 'owner'|'viewer'|'editor'|'administrator', autoRemoveWatched: boolean, autoDownload: boolean, autoPlay: boolean, visibility: 'private'|'followers'|'public', saved: boolean, coverImageUrl: string|null, itemCount: number, posters: string[], createdAt: ISO, updatedAt: ISO}`.
11. `GET /playlists/:id`: `assertRole(viewer)`; `saved = role != 'owner' && a playlist_saves row exists for the caller` (so a share holder who also saved reports `saved: true` here and `false` in the list, rule 9); view built with the caller's ACL stats.
12. `itemCount` / `posters` (per playlist, viewer ACL): `itemCount` = number of `playlist_items` rows whose media is in an accessible library (a series counts once per episode row); `posters` = up to 4 distinct `media.posterUrl` values (distinct by URL, so two titles with the same URL collapse), `posterUrl IS NOT NULL`, ordered by the minimum `position` of each URL. Empty playlist-id list or empty accessible list -> no stats -> `itemCount 0`, `posters []`. SQL verbatim below.
13. `GET /playlists/:id/items`: `assertRole(viewer)`; items `ORDER BY position ASC` (tie-break `id ASC`, positions are not unique, rule 25); empty -> `[]`; media loaded with `library` relation filtered to accessible ids (empty accessible -> `-1`, nothing matches); an item whose media is not loaded (inaccessible) is omitted; the episode and its `season` come from the items that belong to a group.
14. `PlaylistItemView` = `{itemId: number, position: number, addedById: number|null, media: Media, episode: Episode|null, progressPercent: number, watched: boolean}`. `media` is the serialised `Media` entity (`media-query.md`): all columns except `searchVector` (`select:false`), the four release-date keys (`releaseDate`, `inCinemas`, `digitalRelease`, `physicalRelease`, `YYYY-MM-DD` or `null`) appended from the `media_release_dates` join (`media-details.md` rule 4), the `metadata` object (the details row of the media's kind without `mediaId` and `kind`, timestamps as `to_jsonb` prints them, `budget` and `revenue` strings as in `media-query.md` rule 31 and `null` for a series), the collection keys `tmdbCollectionId` and `tmdbCollectionName` (`media-details.md` rule 18), the loaded `library` relation (a full Library row, including `path`: omitted for callers who cannot manage libraries, rule 44) next to `libraryId`, the virtual `path` getter (`@Expose`, library path + folder; omitted likewise), `qualityProfileId`, `languageProfileId`, `addedById`; no `seasons`/`cast`/`crew`/`files`. `episode` is the `Episode` entity (all columns except `searchVector`, plus `seasonId` and the loaded `season` object without its `episodes`), `null` for a movie item; for an episode item `media` is the parent series. Entities are serialised by the global class-serializer (no `@Exclude` on these classes; the contract is the media JSON of `media-query.md`).
15. Progress: the caller's own `playback_states`: the row of `(user, item)`, the item being the entry's episode, else the media's ungrouped item. No row -> `{progressPercent: 0, watched: false}`; `completed` -> `{100, true}`; else `watched false` and `progressPercent = durationSeconds > 0 ? min(100, Math.round(positionSeconds / durationSeconds * 100)): 0` (`Math.round` rounds.5 up).
16. `GET /playlists/:id/members` and the other member routes return `Member[]` (rule 17); any reader (rule 6, including a `public`-visibility reader with no share) can list the roster.
17. `Member` = `{userId: number, username: string, avatar: string|null, role: 'owner'|'viewer'|'editor'|'administrator'}`; the owner first, then the share rows `ORDER BY ps.id`; no `enabled`/`shareDisabled` filter; a share whose user row is missing is skipped.
18. Profile listing (used by `social.md` rule 30): `listVisibleForOwner(ownerId, viewer, includeFollowers)` = playlists of `ownerId` with `visibility IN ('public')`, plus `'followers'` when `includeFollowers`; each as a `PlaylistView` with `role 'viewer'`, `saved false`, stats under the VIEWER's ACL, sorted by name (rule 9); none -> `[]`. A target viewing their own profile therefore sees only their public/followers playlists with role `viewer`.

### C. Playlist writes

19. `POST /playlists`: `INSERT INTO playlists (name, "ownerId", "autoRemoveWatched", "autoDownload", "autoPlay") VALUES (trim(name), $me, flag ?? false,...)`; `visibility` takes the column default `'private'`; the body cannot set it (400 `property visibility should not exist`). `name` is validated (string, <= 255 chars) before the trim, an empty or blank name is accepted and stored as `''`.
20. The create response is `findOneForUser` of the new row: `role 'owner'`, `saved false`, `itemCount 0`, `posters []`, `coverImageUrl null`.
21. `PATCH /playlists/:id`: `assertRole(administrator)` first (404 P / 403 role); then the patch is built from the defined fields (`name` trimmed, the three booleans, `visibility`); `visibility !== 'private'` while `user.shareDisabled` -> 400 `Sharing features are disabled` (no write); a non-empty patch is applied with `UPDATE playlists SET <fields>, "updatedAt" = now() WHERE id = $1` (even when values are unchanged), an empty body writes nothing and leaves `updatedAt`; the response is `findOneForUser` (rule 5 applies to `role`). An administrator-share member (not only the owner) may change `visibility`, rename and set the flags.
22. `DELETE /playlists/:id`: `assertRole(viewer)` (404 P when unreadable), then not owner -> 403 `Only the owner can delete a playlist`; `DELETE FROM playlists WHERE id = $1` (cascade to items, shares, saves); 200 empty.
23. `updatedAt` (`PlaylistView.updatedAt`) moves on: rename/flag/visibility patch (rule 21), item add / remove / reorder (rules 28-31), and every `UPDATE` that leaves it unchanged (the `updatedAt` trigger, rule 40). It does NOT move on auto-remove (rule 37), member changes, saves, or `DELETE items/by-media` that removes nothing.

### D. Members (shares)

24. `POST /members` order: (1) `assertRole(administrator)`; (2) `user.shareDisabled` -> 400 `Sharing features are disabled`; (3) `dto.userId == user.id` -> 400 `Cannot change your own role`; (4) `dto.userId == playlist.ownerId` -> 400 `The owner is already a member`; (5) target user with `enabled = true` else 404 `User #<id> not found`; (6) connectable gate (rule 25) else 403 `You can only add public members or members you follow`; (7) upsert: a share exists -> `UPDATE role` (any of the three roles, including a promotion or demotion of another administrator), else `INSERT`; (8) respond `Member[]` (201).
25. Connectable gate = `!target.shareDisabled && (target.profileVisibility = 'public' || accepted edge caller -> target)`: same reach as `social.md` rules 22 and 40. A `shareDisabled` target answers 404 `User #<id> not found`, like a missing one (rule 43).
26. Delegation: an administrator share can add, promote (to administrator), demote and remove other members including other administrators; only the owner is protected (rules 24 steps 3-4, 27). The added member is not notified (no event).
27. `DELETE /members/:userId`: `assertRole(administrator)`; `userId == caller` -> 400 `Cannot change your own membership`; `userId == ownerId` -> 400 `Cannot remove the owner`; `DELETE FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $2` (removing a non-member is not an error); respond `Member[]` (200). A non-owner member has no way to leave a playlist (the route needs administrator and forbids self): there is no leave route. The removed user's saves, `addedById` attributions and items stay.

### E. Items

28. `POST /items` (`addItem`): `assertRole(editor)`, then `accessible` ids (empty -> `[-1]`), then target resolution (rule 29); no targets -> 201 `{added: 0}`; else one transaction: load the playlist's existing rows, drop targets whose item already has a row; nothing fresh -> single (non-bulk) add 400 `errors.media_already_in_playlist`, bulk add `{added: 0}`; else `position` starts at `MAX(position) + 1` (`0` for an empty playlist) and increases by 1 per inserted row in target order, rows inserted with `addedById = caller`, then `UPDATE playlists SET "updatedAt" = now()`; 201 `{added: n}`.
<<<<<<< HEAD
29. Targets (precedence `episodeId`, then `seasonId`, then `mediaId`; the others are ignored): `episodeId` -> the episode with its season, none (or no season) -> 404 `Episode #<id> not found`; the series (`season.mediaId`) must be of a kind with seasons (`has_seasons`) in an accessible library else 404 `Series #<id> not found`; one target `{mediaId: series, episodeId}`, non-bulk. `seasonId` -> all episodes of the season `ORDER BY episodeNumber`; none (unknown season, empty season) -> `[]` targets (no 404) -> `{added: 0}`; series accessibility as above; bulk. `mediaId` -> media in an accessible library else 404 `Media #<id> not found`; `type = 'series'` -> every episode of every season (specials included) ordered by `(seasonNumber, episodeNumber)`, bulk (a series without episodes -> `{added:0}`); otherwise (movie) one target `{mediaId, episodeId: null}`, non-bulk. No axis -> 400 `errors.playlist_add_target_required`.
=======
29. Targets (precedence `episodeId`, then `seasonId`, then `mediaId`; the others are ignored): `episodeId` -> the episode with its season, none (or no season) -> 404 `Episode #<id> not found`; the series (`season.mediaId`) must be `type = 'series'` in an accessible library else 404 `Series #<id> not found`; one target `{mediaId: series, episodeId}`, non-bulk. `seasonId` -> all episodes of the season `ORDER BY episodeNumber`; none (unknown season, empty season) -> `[]` targets (no 404) -> `{added: 0}`; series accessibility as above; bulk. `mediaId` -> media in an accessible library else 404 `Media #<id> not found`; `type = 'series'` -> every episode of every season (specials included) ordered by `(seasonNumber, episodeNumber)`, bulk (a series without episodes -> `{added:0}`); otherwise (movie) one target `{mediaId, episodeId: null}`, non-bulk, `409 ambiguous_item` when the media has several ungrouped items (`items.md` rule 36). No axis -> 400 `errors.playlist_add_target_required`.
>>>>>>> 487b9c2ad (fix(server): lock item parts before deleting items and refuse ambiguous ungrouped items)
30. Race: a unique violation (23505, concurrent add) is mapped to 400 `errors.media_already_in_playlist` for a single add; for a bulk add the transaction is retried once and a second unique violation answers `{added: 0}`; any other error propagates. Positions are not unique, so two concurrent adds can produce equal `position` values (rule 13's `id` tie-break covers it).
31. `DELETE /items/:itemId`: `assertRole(editor)`; `DELETE FROM playlist_items WHERE id = $2 AND "playlistId" = $1`, no row -> 404 `Playlist item #<itemId> not found` (an item of another playlist is also 404); then `updatedAt = now()`; 200 empty. Remaining positions are NOT renumbered (gaps stay).
32. `DELETE /items/by-media/:mediaId`: `assertRole(editor)`; deletes every row whose item belongs to that `mediaId` (a series: all its episode rows); `updatedAt` bumped only when something was deleted; `{removed: n}` (`0` is 200, no 404); no renumbering.

### F. Reorder (exact semantics)

33. `PUT /items/order` body `{itemIds: number[]}` (IsArray + every element an integer). `assertRole(editor)`; load all item ids of the playlist; the request is valid iff `itemIds` contains no duplicate, has the same length as the playlist's item list, and every id belongs to the playlist; otherwise 400 `itemIds must list every item in the playlist exactly once` and nothing is written (a partial or filtered list is rejected, an empty list is valid only for an empty playlist).
34. Write: one transaction in which, for `idx = 0.. n-1` in request order, `UPDATE playlist_items SET position = idx WHERE id = itemIds[idx]`, then `UPDATE playlists SET "updatedAt" = now() WHERE id = $1` (also bumped for an empty playlist). Result: positions become exactly `0..n-1` in the requested order (gaps closed, the old values irrelevant); 200 empty.
35. The validation read happens inside the transaction, after the row lock of rule 49 (rule 45), so an item added or removed concurrently cannot make the persisted order inconsistent.

### G. Saves

36. `POST /save`: order `user.shareDisabled` -> 400 `Sharing features are disabled`; `assertRole(viewer)` (404 P for an unreadable playlist); owner -> 400 `You already own this playlist`; an existing save -> 201 no-op; else `INSERT INTO playlist_saves ("userId","playlistId")`. `DELETE /save`: `DELETE FROM playlist_saves WHERE "userId" = $me AND "playlistId" = $id`, no role or existence check, 200 empty. A save only adds the playlist to the saver's list (rule 9); read access always comes from visibility or a share (rule 4).

### H. Auto playlists (flags) and `removeWatchedFromAutoPlaylists`

37. There is no rule-based or smart playlist: "auto" playlists are the three boolean flags. Only `autoRemoveWatched` has server behaviour; `autoPlay` (the player advances to the next item) and `autoDownload` (native iOS/Android clients keep the items downloaded) are stored and returned and read by clients only.
38. `removeWatchedFromAutoPlaylists(userId, itemIds)` is called from the heartbeat and the three toggle-watched routes (`heartbeat.md` rules 19-20, `playback-state.md`) and lives with the `playlists` data access: `itemIds` empty -> return (the finished items: a movie's item, or the episodes completed); playlists owned by `userId` with `autoRemoveWatched = true`, none -> return; `DELETE` their rows whose `itemId IN (itemIds)`; in SQL one `DELETE ... WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1 AND "autoRemoveWatched" = true)` with that filter. Only the user's OWN playlists are touched: a member finishing an item never mutates a shared playlist. No renumbering and no `updatedAt` bump (rule 23). Failures are isolated by the callers (`heartbeat.md` rule 20).
39. Parity impact of the above: a scenario that marks watched through `playback` then lists `GET /playlists/:id/items` must show the row gone and positions with a gap, `updatedAt` unchanged (`playlist-auto-remove-*` below).

### I. Privacy on leaving social

40. When a user's `shareDisabled` goes `false -> true` (`users.md` rule 24) the teardown of `social.md` rule 46 removes the user's saves and collaborator shares, deletes all shares of their own playlists (`playlist_shares WHERE playlistId IN owned`), and sets `visibility = 'private'` on every own playlist that is not already private. Statements are verbatim in `social.md` SQL. The `UPDATE playlists SET visibility = 'private'` bumps `"updatedAt"` through the `BEFORE UPDATE` trigger (`1786500000000_updated_at_trigger.sql`, which sets `"updatedAt" = now()` whenever an UPDATE leaves it unchanged), so the playlists move up in the owner's home row; the statement does not stamp `updatedAt` itself. Items stay, `playlist_items.addedById` stays, saves OF their playlists by other users are NOT deleted (those savers no longer list it, rule 42).

### J. Role, readability, member lookup, paths, transactions, ordering

41. `GET /api/playlists/:id` reports the real share role (`editor`/`administrator`) for a share holder on a public/followers-visible playlist (rule 5); the effective role is the highest of owner, share and visibility.
42. A playlist that is private to the saver (made private by its owner, including the leave-social teardown of rule 40) disappears from the saver's `GET /playlists`: entries from `playlist_saves` go through the same readability test as `assertRole(viewer)` (rule 4). The `playlist_saves` rows may stay.
43. `POST /api/playlists/:id/members`: an opted-out (`shareDisabled`) target and a missing or disabled one both answer 404 `User #<id> not found`.
44. The absolute server paths in `PlaylistItemView` (`media.path` getter and `media.library.path`, rule 14) are serialised only for callers who can manage libraries (`settings.access` or `manage:all`); for everyone else the keys are absent. Same rule and audit as `media-query.md` rule 73.
45. Reorder (rules 33-35) and add (rules 28-30) validate and write in one transaction; the leave-social teardown (rule 40, `social.md` rule 53) runs in one transaction with the user update. A failed validation writes nothing.
46. No route answers 500 on input: non-integer / out-of-range ids, unknown playlist/media/season/episode/user ids and nulls on non-nullable fields answer 400 or 404; every list ends with `id ASC` (`items` already ties on `id`, rule 13; members rule 17; playlists list rule 9).
47. The `role` of the `POST /playlists` and `PATCH /playlists/:id` responses is the real one, from the same view builder as `GET /playlists/:id` (an editor or administrator share on a public or followed playlist reports `editor` / `administrator`, not `viewer`).
48. Playlist-name order is byte order then `id` (rule 9). Parity compares `GET /playlists` and the `playlists` of the social profile order-insensitively (`unordered`, README Correctness).
49. Reorder and add take a row lock on the playlist (`SELECT id FROM playlists WHERE id = $1 FOR UPDATE`) as the first statement of their transaction, so concurrent reorders and adds serialise; add computes `MAX(position) + 1` under that lock. A playlist deleted before the lock is taken answers 404 `Playlist #<id> not found`.

## SQL

Queries as SQL; `$me` = caller id, `$acc` = the caller's accessible library ids (`{-1}` where noted when empty).

- Playlist: `SELECT * FROM playlists WHERE id = $1`; follow test: `SELECT EXISTS (SELECT 1 FROM user_follows WHERE "followerId" = $me AND "followingId" = $owner AND status = 'accepted')`; share: `SELECT * FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $me LIMIT 1`.
- List: `SELECT * FROM playlists WHERE "ownerId" = $me`; `SELECT ps.*, p.* FROM playlist_shares ps JOIN playlists p ON p.id = ps."playlistId" WHERE ps."userId" = $me`; `SELECT sv.*, p.* FROM playlist_saves sv JOIN playlists p ON p.id = sv."playlistId" WHERE sv."userId" = $me` (merge per rule 9).
- Profile list: `SELECT * FROM playlists WHERE "ownerId" = $1 AND visibility = ANY($2)` (`$2 = {'public'}` or `{'public','followers'}`).
- Counts and posters, verbatim (`$1` playlist ids int[], `$2` accessible library ids int[]; skipped entirely when either array is empty):
  ```sql
  SELECT c."playlistId" AS "playlistId",
         c.count         AS count,
         COALESCE(p.posters, ARRAY[]::text[]) AS posters
  FROM (
    SELECT pi."playlistId" AS "playlistId", COUNT(*)::int AS count
    FROM playlist_items pi
    JOIN items it ON it.id = pi."itemId"
    JOIN media m ON m.id = it."mediaId"
    WHERE pi."playlistId" = ANY($1)
      AND m."libraryId" = ANY($2)
    GROUP BY pi."playlistId"
) c
  LEFT JOIN (
    SELECT "playlistId", (ARRAY_AGG(poster ORDER BY minpos))[1:4] AS posters
    FROM (
      SELECT pi."playlistId" AS "playlistId",
             m."posterUrl"   AS poster,
             MIN(pi."position") AS minpos
      FROM playlist_items pi
      JOIN items it ON it.id = pi."itemId"
      JOIN media m ON m.id = it."mediaId"
      WHERE pi."playlistId" = ANY($1)
        AND m."libraryId" = ANY($2)
        AND m."posterUrl" IS NOT NULL
      GROUP BY pi."playlistId", m."posterUrl"
) d
    GROUP BY "playlistId"
) p ON p."playlistId" = c."playlistId"
  ```
- Items: `SELECT pi.*, it."mediaId", it."groupId" FROM playlist_items pi JOIN items it ON it.id = pi."itemId" WHERE pi."playlistId" = $1 ORDER BY pi.position ASC, pi.id ASC` (`id` tie-break); the media of a row is its item's, the episode is the item when it has a group. Media: `SELECT m.*, md.*, l.* FROM media m INNER JOIN libraries l ON l.id = m."libraryId" LEFT JOIN movie_details md ON md."mediaId" = m.id LEFT JOIN series_details sd ON sd."mediaId" = m.id WHERE m.id = ANY($ids) AND l.id = ANY($acc|{-1})`. Episodes: `SELECT e.*, s.* FROM items e LEFT JOIN item_groups s ON s.id = e."groupId" WHERE e.id = ANY($eps)`. States: `SELECT * FROM playback_states WHERE "userId" = $me AND "itemId" = ANY($items)`.
- Create: `INSERT INTO playlists (name, "ownerId", "autoRemoveWatched", "autoDownload", "autoPlay") VALUES ($1,$2,$3,$4,$5) RETURNING id, "createdAt", "updatedAt", visibility, "coverImageUrl"`. Update: `UPDATE playlists SET <fields>, "updatedAt" = now() WHERE id = $1`. Delete: `DELETE FROM playlists WHERE id = $1`. Save: `SELECT * FROM playlist_saves WHERE "userId" = $1 AND "playlistId" = $2`; `INSERT INTO playlist_saves ("userId","playlistId") VALUES ($1,$2)`; unsave: `DELETE FROM playlist_saves WHERE "userId" = $1 AND "playlistId" = $2`.
- Members: `SELECT * FROM users WHERE id = $owner`; `SELECT ps.*, u.* FROM playlist_shares ps JOIN users u ON u.id = ps."userId" WHERE ps."playlistId" = $1 ORDER BY ps.id`; target: `SELECT * FROM users WHERE id = $1 AND enabled = true`; upsert: `SELECT * FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $2` then `UPDATE playlist_shares SET role = $3, "updatedAt" = now() WHERE id = $id` or `INSERT INTO playlist_shares ("playlistId","userId",role) VALUES ($1,$2,$3)`; remove: `DELETE FROM playlist_shares WHERE "playlistId" = $1 AND "userId" = $2`.
- Add targets: episode `SELECT e.*, s.* FROM items e LEFT JOIN item_groups s ON s.id = e."groupId" WHERE e.id = $1`; season `SELECT e.*, s.* FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE s.id = $1 ORDER BY e."number" ASC`; media `SELECT * FROM media WHERE id = $1 AND "libraryId" = ANY($acc)`; series episodes `SELECT e.*, s.* FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = $1` sorted in code by `(s."number", e."number")`; series check `SELECT * FROM media WHERE id = $1 AND type = 'series' AND "libraryId" = ANY($acc)`.
- Add transaction: `SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1`; `SELECT MAX(i.position) AS max FROM playlist_items i WHERE i."playlistId" = $1`; `INSERT INTO playlist_items ("playlistId","itemId","addedById",position) VALUES ($1,$2,$me,$pos),...`; a movie target is `item_of($media, NULL)`, an episode target its own id; `UPDATE playlists SET "updatedAt" = now() WHERE id = $1`.
- Remove: `DELETE FROM playlist_items WHERE id = $2 AND "playlistId" = $1`; by media: `DELETE FROM playlist_items WHERE "playlistId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2)`; both followed by `UPDATE playlists SET "updatedAt" = now() WHERE id = $1` (by-media only when rows were deleted).
- Reorder: `SELECT * FROM playlist_items WHERE "playlistId" = $1`; in a transaction `UPDATE playlist_items SET position = $idx WHERE id = $id` per element, then `UPDATE playlists SET "updatedAt" = now() WHERE id = $1`.
- Auto-remove: `SELECT * FROM playlists WHERE "ownerId" = $1 AND "autoRemoveWatched" = true`; `DELETE FROM playlist_items WHERE "playlistId" IN ($ids) AND "itemId" = ANY($items)`.
- Leave-social: six statements verbatim in `social.md` SQL.

## Events

none. Playlist mutations emit no SSE or domain event; clients refetch. (The only playlist-adjacent event traffic is `social.md`'s four `social.*` events.)

## Settings keys

none

## Jobs/timers

none

## Vectors/parity

No fixture set. Rust unit tests (table-driven): the `assertRole` matrix of rule 6 (every route x {owner, A, E, V, none+pub, none+fol with and without follow, none+private}), the role reporting of rule 5, add-target resolution (rule 29 precedence and the three bulk/non-bulk outcomes), reorder validation and positions `0..n-1` (rules 33-34), progress rounding (rule 15), the `removeWatchedFromAutoPlaylists` isolation (owner-only, a movie's item vs episodes, empty list).

Parity scenarios (`server/parity/scenarios/playlists/`), `as` in `admin|user|readonly|other`: `list` (owned + shared + saved, order by name), `create`, `create-validation` (400, unknown key `visibility`, name 256 chars), `create-readonly` (201 for the readonly role, rule 3), `get-owner`, `get-public-nonmember` (role `viewer`), `get-followers-visibility` (follower 200, non-follower 404), `get-private-nonmember` (404), `get-badid` (400), `patch-owner`, `patch-empty-body` (`updatedAt` unchanged), `patch-visibility-opted-out` (400), `patch-editor` (403 role), `patch-nonmember` (404), `patch-admin-share` (200), `delete-owner`, `delete-nonowner-reader` (403 message), `delete-nonmember` (404), `items-list` (ACL: viewer lacking a library omits items; `media`/`episode` JSON shape, progress), `items-add-movie`, `items-add-movie-twice` (400 `errors.media_already_in_playlist`), `items-add-episode`, `items-add-season` (`added` = episodes; again -> `added 0`), `items-add-series` (ordering by season, episode), `items-add-unknown-season` (`added 0`), `items-add-no-target` (400), `items-add-inaccessible` (404), `items-add-viewer` (403), `items-remove`, `items-remove-unknown` (404), `items-remove-by-media`, `items-reorder` (then list shows positions `0..n-1`), `items-reorder-partial` (400), `items-reorder-duplicate` (400), `items-reorder-foreign-id` (400), `members-list`, `members-add` (then the member's list shows the playlist with its role), `members-add-self` (400), `members-add-owner` (400), `members-add-private-unfollowed` (403), `members-add-opted-out` (403), `members-add-unknown` (404), `members-promote-admin` (peer administrator allowed), `members-remove`, `members-remove-self` (400), `members-remove-owner` (400), `save`, `save-own` (400), `save-twice`, `save-unreadable` (404), `save-opted-out` (400), `unsave`, `saved-after-private` (gone from the list, GET 404), `get-editor-share-public` (`role: editor`), `members-add-opted-out` (404), `items-library-path-hidden` (non-manager: `path`/`library.path` absent), `playlist-auto-remove-heartbeat` / `playlist-auto-remove-toggle` / `playlist-auto-remove-shared-untouched` (steps in `playback` routes then `GET items`; owner-only), `leave-social` (via `PUT /api/users/:id {shareDisabled:true}`: shares, saves removed, playlists private, `updatedAt` newer). Seed needs: playlists with every visibility, shares at all three roles, a save-only entry, an accepted follow, an `autoRemoveWatched` playlist, a viewer lacking one library, item rows with a position gap.
