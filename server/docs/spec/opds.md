# Spec: OPDS 1.2 catalogue

Scope: the Atom catalogue an e-reader app (KOReader, Moon+ Reader, Librera, Cantook, Panels) browses to find and download books and comics, with OPDS-PSE page streaming for comics: its routes, its credential, the ACL on every entry and link, and the feed shapes. The credential is a device token of kind `opds` (`device-tokens.md`); the bytes are not served here: every acquisition link goes to the engine's data plane, which resolves the same Basic credential (`device-tokens.md` rules 7-10). The books domain is `books.md` and `books-api.md`, the comics domain `comics.md`; nothing here has its own table.

## Routes

All `GET` (and `HEAD`), under `/api/opds` so that the engine front door forwards them. The `Content-Type` of a feed is `application/atom+xml;profile=opds-catalog;kind=navigation` or `...;kind=acquisition`, always with `; charset=utf-8`.

| Route | Feed | Filled by |
|---|---|---|
| `/api/opds` | navigation: libraries, recently added, authors, series, comics | libraries readable by the caller that hold books or comics |
| `/api/opds/libraries/:id` | acquisition: the books of the library, by title; navigation: its comic volumes when it holds no books (rule 16) | `media::list::find_all` |
| `/api/opds/recent` | acquisition: the newest books (`createdAt DESC`) | `media::list::find_all` |
| `/api/opds/authors` | navigation: authors, by `COALESCE(sortName, name)` | `persons::service::people` |
| `/api/opds/authors/:id` | acquisition: the author's books, by title | `media::list::find_all` (`authorId`) |
| `/api/opds/series` | navigation: series (book collections), by name | `collections::service::list` |
| `/api/opds/series/:id` | acquisition: the series in position order | `collections::service::detail` |
| `/api/opds/comics` | navigation: the comic volumes, by title | `media::list::find_ids` (`type=comic`) |
| `/api/opds/comics/:id` | acquisition: the issues of a volume | `comic_issues` (rule 17) |
| `/api/opds/issues/:itemId/pages/:index?width=` | the page image (PSE stream URL) | `comics::serve_page` (rule 19) |
| `/api/opds/search?q=` | acquisition: books matching `q`, then the comic volumes matching it | `media::list::find_all` (`q`) |
| `/api/opds/opensearch.xml` | `application/opensearchdescription+xml` | none |

## Credential

1. The credential is `Authorization: Basic base64(identifier:token)`: the identifier is free (at most 255 bytes) and ignored, the token is everything after the first `:` and must be a well-formed `opds` token (`device-tokens.md` rule 12). A cookie, a Bearer, `?token=` or a user's password is no credential: nothing but a device token opens these routes, and a `kosync` token never matches.
2. No credential, an unreadable one, an unknown, renewed or revoked token, or a token of a disabled user is `401` with `WWW-Authenticate: Basic realm="Fliks", charset="UTF-8"` and no body detail. A hit stamps `lastUsedAt`. A role without `media.read` is `403 Forbidden resource`.
3. Failure throttle, in-process, per client network (`auth.md` rule 63; an IPv6 client keyed by its /64), on the limiter of the login (`auth.md` rule 39) under a key no username can take: only a presented credential that fails counts (a request with no `Authorization` is the challenge round of a reader and is free). The 6th failure within 15 minutes is `429 Too many failed attempts, try again later` with `Retry-After: 900`, and every failure after it until the window ends; a valid token is never throttled, since 256 bits of randomness is the protection and a reader's parallel cover requests must not lock it out. A malformed credential counts without a lookup.
4. Feeds carry `Cache-Control: private, no-cache` and `X-Content-Type-Options: nosniff`.

## Access

5. The caller is the token's owner, with their library ACL (`libraries.md` rules 30-36): `accessible_library_ids` bounds every list and every entry. A work in a library the owner cannot read is in no feed. An edition is listed only when `COALESCE(editions."libraryId", media."libraryId")` is readable (`books.md` rule 22), and a file link only when no edition linking the file is hidden (`libraries::HIDDEN_FILES_FROM`, `engine-glue.md` rule 41). Entries are read by one query that re-applies the work, edition and file rules whatever list produced the ids.
6. A hidden library, author or series and a missing one are the same `404`: a library is served only when it is readable and its `mediaTypes` holds `book` or `comic` (rule 16); an author or a series is served only when at least one readable book belongs to it. The navigation lists count only readable books (`books-api.md` A7 and A9).
7. A book with no downloadable file (a wanted shell, or every edition hidden) is left out of an acquisition feed, so a page can hold fewer than 50 entries.

## Feeds

8. A feed is Atom 1.0 with the OPDS 1.2 relations: `self`, `start` (`/api/opds`), `up` (the parent feed, absent on the root), `search` (twice: the OpenSearch description, and the direct `application/atom+xml` template `/api/opds/search?q={searchTerms}`), and `next` and `previous` when the list has them. Hrefs are absolute paths. Ids are URNs: `urn:fliks:opds:<route>[:<id>]` for a feed, `urn:fliks:book:<mediaId>` for a book entry, `urn:fliks:comic-volume:<mediaId>` for a comic volume and `urn:fliks:comic:<itemId>` for an issue (rules 16-17).
9. Lists are paged by `?page=` (from 1, 50 entries per page; a `page` that is not an integer from 1 is `400 page must not be less than 1`). `next` is present when a row exists after the page, `previous` when `page > 1`.
10. A navigation entry is `{ title, id, updated, content, link rel="subsection" }` with `content` the count of books (`N issues` for a comic volume) where known. An acquisition entry is `{ title, id, updated (media updatedAt), author[], summary (overview, 4000 characters at most), dc:language, dc:publisher, dc:issued (the year), links }`; `language` and `publisher` are the first visible edition's that carries one.
11. Links of an entry: `http://opds-spec.org/image` and `/image/thumbnail` when the work has a local poster (`/api/images/media/<id>/poster`, the public image route of `images.md`, `?size=thumb` for the thumbnail), and one `http://opds-spec.org/acquisition` per file of each visible edition (`text` before `audio`), (a `text` edition: the files of every `version`, one per format, highest `version` first; an `audio` edition: the files of its highest `version`), in `position` order: `href` `/api/stream/<fileId>?download=1`, `type` the MIME type of the extension (`application/octet-stream` when unknown), `length` the size in bytes, `title` the upper-case extension (`EPUB`, with ` n/m` when the edition has several files of that extension).
12. Text is XML-escaped and characters XML 1.0 forbids are dropped. OPDS 1.2 has no series element: the series order is the entry order of a series feed.
13. Search: `q` is trimmed and cut to 200 characters; an empty `q` is an empty feed. Matching is the book search of `media-query.md` (`q` of `GET /api/media?type=book`); comic volumes are appended (rule 21).

## Not covered

14. OPDS 2.0 is not planned, and neither are per-device scopes beyond the token kind. Facets and `rel="related"` links are left out. The recently-added, author and series feeds list books only; a comic is reached through its library, `/api/opds/comics` and search.
15. Acquisition links of audio editions are one per file; OPDS 1.2 has no multi-file audiobook model, so a reader that does not play audio ignores them.

## Comics and page streaming

16. A library is listed (root, `/api/opds/libraries/:id`) when it holds `book` or `comic`. A library that holds comics and no books answers a navigation feed of its volumes (`find_ids`, `type=comic`, by title); one that holds both answers its books, its comics being under `/api/opds/comics`. The root carries a `Comics` entry when a readable library holds comics. A volume is listed only with at least one readable issue; a missing, hidden or non-comic id is `404 Comic #<id> not found`.
17. `/api/opds/comics/:id` is an acquisition feed of the volume's issues in the order of `comics.md` rule 9 (issues by `"sortNumber"`, then annuals and specials), 50 per page. An issue is listed when its edition is readable (`COALESCE(editions."libraryId", media."libraryId")`) and the file `comic_part(item, user)` names (`comics.md` rule 26) is hidden by no edition (`HIDDEN_FILES_FROM`); a page past the last is empty, an empty first page `404`. An entry is `{ title (`<volume> #<label>`, `Annual` or `Special` before the `#`, `: <issue title>` when it has one), id `urn:fliks:comic:<itemId>`, updated (the volume's), dc:publisher (the volume's), dc:issued (the release year), links }`.
18. Links of an issue: one `http://opds-spec.org/acquisition` to the part file, like a book's (rule 11), `type` `application/vnd.comicbook+zip` (`cbz`), `application/x-cb7`, `application/vnd.comicbook-rar` or `application/pdf`; and, when `"pageCount"` is not NULL (a PDF or an unreadable archive has none), the OPDS-PSE 1.2 link `rel="http://vaemendis.net/opds-pse/stream"`, `type="image/jpeg"`, `href="/api/opds/issues/<itemId>/pages/{pageNumber}?width={maxWidth}"`, `pse:count` the page count and, when the caller has a playback state with a numeric `locator.page` (`comics-contract.md`, Progress) or a completed one, `pse:lastRead` (1-based, clamped to the count; the count when completed with no page) and `pse:lastReadDate` (that state's `lastPlayedAt`, UTC). Every feed declares `xmlns:pse="http://vaemendis.net/opds-pse/ns"`.
19. The stream URL runs the page route of `comics.md` rules 26-28 (same ACL, issue resolution, ETag, caches, budgets and job slots) under the OPDS credential of rules 1-3, not the cookie or the stream token. `{pageNumber}` is the 0-based index. `{maxWidth}` is clamped to 1 to 4096 then snapped like `width` (a value that is not a number, such as a placeholder the client did not replace, counts as absent); with no width the page is served at 4096 so the answer is always a JPEG (a JPEG source no wider than the width is served as stored), as the link declares (the page route without `width` may answer a png, webp or gif).
20. Reading progress is read-only: OPDS-PSE 1.2 defines no write path, so a PSE client leaves the state untouched (a reader that wants to sync uses the playback routes).
21. Search (rule 13) answers up to 50 books followed by up to 50 comic volumes as navigation entries; `next` is present when either list continues.
