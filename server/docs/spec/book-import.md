# Spec: book import

Scope: adopting an existing book library in one job (`bulk import`) and the queue of works it could not identify (`manual import`). Files, editions, items and parts are written by `book-ingest.md`, identification and linking by `book-metadata.md`; this file only decides which works to take, in which order, how the job survives a restart and what the caller sees. The classifier replaces the work grouping the orphan scan did inline (`ingest.md` rules 60-66).

## Routes

Guards: `media.create` and a library the caller reaches (404 `Library #<id> not found` otherwise), as the orphan scan.

| Method path | Response | Errors |
|---|---|---|
| `POST /api/imports/library/{libraryId}/books` | 202 `BookImport` | 400 `Library "<name>" does not accept book`, 400 when the library has no folder, 409 `errors.already_running` |
| `GET /api/imports/library/{libraryId}/books` | 200 `BookImport`, the library's latest | 404 `errors.book_import_not_found` |
| `GET /api/imports/library/{libraryId}/books/queue` | 200 `{total, items: [QueueItem]}`, at most 500, oldest first | |

`BookImport` = `{id, libraryId, status, total, pending, matched, manual, skipped, failed, error, createdAt, updatedAt, endedOn}`: `status` is `running`, `completed` or `failed`; `total` is `null` until the scan has planned the job; the five counts are the items by status. `QueueItem` = `{id, importId, mediaId, title, folderName, files, error}` (`files` the relative paths the item took). A queue item is resolved with the routes that exist: `PUT /api/media/:id/sources` (`book-metadata.md` rule 23) links it, a book already linked leaves the queue.

## Rules

### Classifier

1. `ingest::books::plan::plan(rels, owner) -> Vec<Planned>` is pure. `rels` is every book file of one folder root (`/`-separated, linked or not), `owner(rel)` the `folderName` of the media that links the file, `None` when none does. It groups with `group::group` (`book-ingest.md` rules 2-4) and answers, in the order of `group`, the works that still have a file to take: `Planned {dir, name_path, anchor, title, year, files}`, `files` being the unlinked files of the work in `group` order. A work whose files are all linked is not planned.
2. `anchor` is `Some(dir)` only when the work is anchored by its folder (`book-ingest.md` rule 10): `dir` is not the root, no other work of the root, linked or not, has the same `dir` or one below it, and every linked file of the work belongs to a media whose `folderName` is `dir`. Otherwise it is `None` and the work's media has the folder name `''`, owns its files by path and is created once per work. `title` and `year` come from `filename::parse_path(name_path)`, the title falling back to the last component of `dir`.
3. The classifier never plans a file another media owns: it only ever lists unlinked files, and `register` (`book-ingest.md` rule 6) refuses one that was linked in the meantime.

### The job

4. One import per library runs at a time, enforced by a unique index on `book_imports("libraryId") WHERE status = 'running'` (a second start is 409). `POST` inserts the row `running` with the caller as `userId` and answers 202; the job runs detached. `book_imports` and `book_import_items` are cascade-deleted with their library, and the import with its user.
5. Planning, first stage: for each folder of the library (`library_folders`, by position) the walk of the orphan scan reads the book files four levels deep without following links (`book-ingest.md` rule 1), `plan` classifies them with the files already linked in the library, and one transaction inserts an item per planned work (`folderId`, `groupKey` = `name_path`, `folderName` = the anchor or `''`, `title`, `year`, `files`, status `pending`) and sets `total`. A restart before `total` is set plans again; after it, the items are not read from disk again. An empty plan completes the job. A failing walk (no folder, unreadable root) ends the job `failed` with the error.
6. Importing, second stage: items run one at a time in `id` order, each `pending` until it ends. An item links its files in place as the orphan relink does for a book, with no identification and no transfer: an unmatched book media is found or created (by folder name, or by the paths of a loose work), the files are registered under the media's lock. `folder_moves` is held for reading from the read of the folder's path through the link (`book-ingest.md` rule 17), so a folder cannot move between the two. A move that runs between two items is harmless: the files are resolved by `(folderId, relative path)` against the folder's current path, and a file that is gone is an item error.
7. Identification follows the link in the same item, sequentially, at `Background` priority, through `identify_media` (`book-ingest.md` rule 16); the settle timer the link armed is cancelled so the work is looked up once. The provider limiter paces the calls (`metadata-orchestrator.md` rules 12-16): the job never goes around it, runs one lookup at a time and never takes an interactive slot.
8. An item ends `matched` when its media holds the anchor work id after the identification, `manual` when it does not (below the confidence threshold), `skipped` when nothing was linked and nothing failed (every file is already there), `failed` with `error` when the link raised or linked nothing and reported errors (a file another media owns is such an error: it is never taken). `identify_media` fails when the anchor provider is disabled or a call fails: that is not a "no match". Only an outage keeps the item `pending` with the cause in `error` (anchor disabled or unavailable, circuit open, transport failure, 429, upstream 5xx): the job waits (5 s, doubling to 5 min, reset by the next item that ends) before it retries the same item, which is idempotent (rule 10). Any other error (upstream 4xx, an invalid record, a database error) ends the item `failed` with the cause and the job goes on. An item error never stops the job: a database error on one item, such as its media deleted while it waited, marks that item `failed` (its `mediaId` is written only when the media still exists, else null) and the job goes on. Errors of some files of an item that linked others stay in `error` of a `matched` or `manual` item.
9. The job ends `completed` once no item is `pending`. The caller sees it live: `GET` counts the items, the activity row `BookImport:<id>` (type `BookImport`, the library's name as subject) carries `current = total - pending` and `total`, and `task.progress` `{command: 'BookImport', current, total, message}` is emitted after each item and at the end. Nothing is held in memory that a restart would lose.
10. Resume: at startup, after migrations, every `running` import is continued from its pending items (or planned again, rule 5); an item interrupted mid-way is imported again, which is idempotent (files re-registered by `(folder, path)`, the media found by its folder name or paths, an identified edition not looked up again). Only the job's own tasks run in the background: the unmatched media a failed import leaves stay valid books.

### Manual import

11. The queue is the `manual` items of the library's imports whose media still has no anchor work id; an item leaves it when the book is linked by any route. Importing files the job did not take (a folder outside the library, a file chosen by hand) stays the orphan relink (`ingest.md` rules 72-92), which takes a book as `type: 'book'` with a `folderName` of one or several components.

## Tests

`ingest::books::plan` unit tests: an anchored `Author/Title` work, a loose file, two works in one folder (both loose), a work above another (neither anchored), a linked file of another media never taken, an `Author/Series/Title` anchor. `ingest/tests.rs` (`book_import`) runs the job against a throwaway database: anchored, loose and already-linked works with their statuses, the queue and its exit by linking, a job interrupted after some items and resumed (every work once), and 200 works against a stub provider behind `Guarded` whose limiter the test reads back: no call outside `Background`, one at a time, never above the declared rate.
