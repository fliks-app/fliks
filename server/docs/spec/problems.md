# Spec: problems (problem reports on a media)

A user reports a problem with a title, a season, an episode or one file (`media_issues`); a manager follows it to a fix. The table is separate from `requests`: no request route, counter, event or push reads it, so released clients see nothing new. Auth and error bodies are in `auth.md`; notifications in `notifications.md` ("notif rule N"); push in `push.md`; the bus in `events-hub.md`. Code: `server/crates/server/src/problems/`.

## Routes

Every route is authenticated (a scoped stream token is 401). POST = 201, DELETE = 200. A manager is `requests.manage` or `manage:all` (`can_manage`); a manager reaches the reports of the libraries they read (all of them for `manage:all`).

| Method path | Gate | Request | Answer |
|---|---|---|---|
| `POST /api/media/{id}/problems` | `media.read`; the media must be readable (library and declared kinds), else 404; `mediaFileId` unreadable or missing is 404 | `{kind, itemId?, seasonNumber?, mediaFileId?, note?}` (rule 1) | 201 row; 409 `problem_already_open`, `problem_cap` |
| `GET /api/problems?status=&mediaId=&page=&limit=` | a reporter reads their own, a manager the rows of their libraries | `status` in `active` (open + acknowledged), `open`, `acknowledged`, `resolved`, `closed`; `page` from 1; `limit` 1 to 100 (20) | `{data, total}`, newest first |
| `GET /api/problems/{id}` | reporter, or manager of the library; else 403 | | row + `comments` + (manager only) `playback` |
| `POST /api/problems/{id}/resolve` | manager | `{reply?}` | 201 row; 409 `problem_not_active` |
| `POST /api/problems/{id}/close` | manager | `{reason}` (required) | 201 row; 409 `problem_not_active` |
| `POST /api/problems/{id}/reopen` | reporter or manager (rule 7) | `{note}` (required for a reporter) | 201 row; 409 `problem_reopen_denied`, `problem_reopen_window`, `problem_already_open`, `problem_cap` |
| `DELETE /api/problems/{id}` | reporter while active, manager always | | 200 |
| `GET|POST /api/problems/{id}/comments`, `DELETE /api/problems/comments/{commentId}` | reporter or manager; deleting needs the author or a manager | `{message}` | comment, same shape as request comments with `issueId` |

Bodies reject unknown keys (400). Text fields are at most 2000 characters; a blank optional one is dropped.

## Rules

### A. Create

1. `kind` is one of `video`, `audio`, `subtitles`, `playback`, `other`. `itemId` and `seasonNumber` together are 400. An `itemId` of another media is 400; its season and episode numbers are stored from the item, so the label survives the item. A `mediaFileId` that is not a file of the media (or a part of the item) is 400.
2. With no `mediaFileId`, the server pins the scope's only file (an item's part; a whole title's file); a season pins none. The pin is `mediaFileId` and its `fileSize`. Unmatched media are reportable.
3. Under the reporter's advisory quota lock (shared with request creation), in one transaction: a report with the same user, media, scope numbers, item, kind and an active status is 409 `problem_already_open`; 20 active reports per user is 409 `problem_cap`; then the insert and the note as the first comment. There is no unique index, so an item set to NULL by a metadata refresh or a book absorb cannot fail on a constraint.
4. A metadata refresh that drops the item keeps the report (`itemId` NULL, numbers kept). A book or album absorb moves the reports to the kept media. Removing a media removes its reports (the reporter is not told). Removing the reporter removes their reports.

### B. States

5. `open` to `acknowledged`: the first comment of a manager other than the reporter, no route. `open` or `acknowledged` to `resolved` (`resolve`, `resolvedById` and `resolvedAt` set, the reply a comment) or to `closed` (`close`, the reason a comment). Anything else on these routes is 409 `problem_not_active`.
6. `DELETE`: the reporter withdraws an active report; a manager deletes any; the reporter on a fixed or closed one is 403.
7. `reopen` clears `resolvedById`, `resolvedAt` and `autoResolved` and goes to `open`. A manager reopens from `resolved` or `closed`. A reporter only from `resolved`, within 14 days of `resolvedAt` (409 `problem_reopen_window`); from `closed` it is 409 `problem_reopen_denied`. It runs under the quota lock of the reporter, never the caller, and repeats the duplicate and cap checks (rule 3), without counting itself. It pins the file as it is now (the pinned file if it still exists, else the scope's only file), so the replacement judged broken does not resolve the report again.
8. A comment of the reporter never changes the state; a comment of anyone else notifies the reporter (rule 20).

### C. Auto-resolve

9. One `UPDATE` over active reports with a `fileSize`, by media on `media.files.imported` and for all media in the hourly request reconcile and on a lagged feed. It resolves (`autoResolved` true, `resolvedAt` now, no `resolvedById`) when the pinned file is gone and a file of the scope has `createdAt` later than the report, or the pinned file still exists with another `size`. The scope's files are the `item_parts` of `itemId`; the media's files for a whole title.
10. A report with `itemId` NULL and a season or episode number is skipped: it stays open for a manager. A file only re-probed (`updatedAt`) resolves nothing.
11. Ceiling: a same-size in-place replacement is caught by neither condition. Subtitle reports resolving on `subtitle.downloaded` are not done.

### D. Wire

12. A row is `{id, createdAt, updatedAt, status, kind, itemId, seasonNumber, episodeNumber, fileSize, autoResolved, resolvedAt, media: {id, type, title, posterUrl}, file: {id, name, quality, size} | null, user, resolvedBy | null, commentCount, lastReply | null}`. `user` and `resolvedBy` are `{id, username, avatar}`; `file.name` is the last path segment; `lastReply` is the latest comment by someone other than the reporter. The detail adds `comments` (oldest first) and, for a manager, `playback`: the reporter's latest QoE session of the pinned file started before the report, or null.
13. A comment is `{id, createdAt, updatedAt, issueId, userId, user | null, message}`.

### E. Notifications, counts

20. Admin events `problem.created` (a create or a reopen) and `problem.resolved` (manual or auto) through `notifications::dispatch`, payload `{title, mediaType, kind, seasonNumber, episodeNumber}`. Push, category `requests` (`push.md` rule 32): `problem_created` to the managers who read the library, minus the reporter, opening `/requests?view=problems&status=active`; `problem_resolved`, `problem_replied`, `problem_closed` to the reporter. No `request.*` event or push is emitted.
21. `GET /api/counts` gains `openProblems`: a manager's open (not acknowledged) reports in their libraries and declared kinds, else 0.
22. Reserved for the health checks: `media_issues."source"` with `"userId"` nullable only for health rows; today `userId` is NOT NULL with CASCADE.

## Tests

`server/crates/server/tests/it/problems.rs`: create gates, duplicate and cap, every transition and permission, reopen window and lock, auto-resolve cases of rules 9-10, refresh and absorb, push recipients, `openProblems`, requests unchanged.
