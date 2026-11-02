# Spec: OPDS 1.2 catalogue

Scope: the Atom catalogue an e-reader app (KOReader, Moon+ Reader, Librera, Cantook) browses to find and download books: its routes, its credential, the ACL on every entry and link, and the feed shapes. The credential is a device token of kind `opds` (`device-tokens.md`); the bytes are not served here: every acquisition link goes to the engine's data plane, which resolves the same Basic credential (`device-tokens.md` rules 7-10). The books domain is `books.md` and `books-api.md`; nothing here has its own table.

## Routes

All `GET` (and `HEAD`), under `/api/opds` so that the engine front door forwards them. The `Content-Type` of a feed is `application/atom+xml;profile=opds-catalog;kind=navigation` or `...;kind=acquisition`, always with `; charset=utf-8`.

| Route | Feed | Filled by |
|---|---|---|
| `/api/opds` | navigation: libraries, recently added, authors, series | libraries readable by the caller that hold books |
| `/api/opds/libraries/:id` | acquisition: the books of the library, by title | `media::list::find_all` |
| `/api/opds/recent` | acquisition: the newest books (`createdAt DESC`) | `media::list::find_all` |
| `/api/opds/authors` | navigation: authors, by `COALESCE(sortName, name)` | `persons::service::people` |
| `/api/opds/authors/:id` | acquisition: the author's books, by title | `media::list::find_all` (`authorId`) |
| `/api/opds/series` | navigation: series (book collections), by name | `collections::service::list` |
| `/api/opds/series/:id` | acquisition: the series in position order | `collections::service::detail` |
| `/api/opds/search?q=` | acquisition: books matching `q` | `media::list::find_all` (`q`) |
| `/api/opds/opensearch.xml` | `application/opensearchdescription+xml` | none |

## Credential

1. The credential is `Authorization: Basic base64(identifier:token)`: the identifier is free (at most 255 bytes) and ignored, the token is everything after the first `:` and must be a well-formed `opds` token (`device-tokens.md` rule 12). A cookie, a Bearer, `?token=` or a user's password is no credential: nothing but a device token opens these routes, and a `kosync` token never matches.
2. No credential, an unreadable one, an unknown, renewed or revoked token, or a token of a disabled user is `401` with `WWW-Authenticate: Basic realm="Fliks", charset="UTF-8"` and no body detail. A hit stamps `lastUsedAt`. A role without `media.read` is `403 Forbidden resource`.
3. Failure throttle, in-process, per client network (`auth.md` rule 63; an IPv6 client keyed by its /64), on the limiter of the login (`auth.md` rule 39) under a key no username can take: only a presented credential that fails counts (a request with no `Authorization` is the challenge round of a reader and is free). The 6th failure within 15 minutes is `429 Too many failed attempts, try again later` with `Retry-After: 900`, and every failure after it until the window ends; a valid token is never throttled, since 256 bits of randomness is the protection and a reader's parallel cover requests must not lock it out. A malformed credential counts without a lookup.
4. Feeds carry `Cache-Control: private, no-cache` and `X-Content-Type-Options: nosniff`.

## Access

5. The caller is the token's owner, with their library ACL (`libraries.md` rules 30-36): `accessible_library_ids` bounds every list and every entry. A work in a library the owner cannot read is in no feed. An edition is listed only when `COALESCE(editions."libraryId", media."libraryId")` is readable (`books.md` rule 22), and a file link only when no edition linking the file is hidden (`libraries::HIDDEN_FILES_FROM`, `engine-glue.md` rule 41). Entries are read by one query that re-applies the work, edition and file rules whatever list produced the ids.
6. A hidden library, author or series and a missing one are the same `404`: a library is served only when it is readable and its `mediaTypes` holds `book`; an author or a series is served only when at least one readable book belongs to it. The navigation lists count only readable books (`books-api.md` A7 and A9).
7. A book with no downloadable file (a wanted shell, or every edition hidden) is left out of an acquisition feed, so a page can hold fewer than 50 entries.

## Feeds

8. A feed is Atom 1.0 with the OPDS 1.2 relations: `self`, `start` (`/api/opds`), `up` (the parent feed, absent on the root), `search` (twice: the OpenSearch description, and the direct `application/atom+xml` template `/api/opds/search?q={searchTerms}`), and `next` and `previous` when the list has them. Hrefs are absolute paths. Ids are URNs: `urn:fliks:opds:<route>[:<id>]` for a feed, `urn:fliks:book:<mediaId>` for an entry.
9. Lists are paged by `?page=` (from 1, 50 entries per page; a `page` that is not an integer from 1 is `400 page must not be less than 1`). `next` is present when a row exists after the page, `previous` when `page > 1`.
10. A navigation entry is `{ title, id, updated, content, link rel="subsection" }` with `content` the count of books where known. An acquisition entry is `{ title, id, updated (media updatedAt), author[], summary (overview, 4000 characters at most), dc:language, dc:publisher, dc:issued (the year), links }`; `language` and `publisher` are the first visible edition's that carries one.
11. Links of an entry: `http://opds-spec.org/image` and `/image/thumbnail` when the work has a local poster (`/api/images/media/<id>/poster`, the public image route of `images.md`, `?size=thumb` for the thumbnail), and one `http://opds-spec.org/acquisition` per file of each visible edition (`text` before `audio`), in the item's highest `version` and `position` order: `href` `/api/stream/<fileId>?download=1`, `type` the MIME type of the extension (`application/octet-stream` when unknown), `length` the size in bytes, `title` the upper-case extension (`EPUB`, with ` n/m` when the edition has several files).
12. Text is XML-escaped and characters XML 1.0 forbids are dropped. OPDS 1.2 has no series element: the series order is the entry order of a series feed.
13. Search: `q` is trimmed and cut to 200 characters; an empty `q` is an empty feed. Matching is the book search of `media-query.md` (`q` of `GET /api/media?type=book`).

## Not covered

14. OPDS-PSE (page streaming) is phase 7 (plan 7.5), OPDS 2.0 is not planned, and neither are per-device scopes beyond the token kind. Facets and `rel="related"` links are left out.
15. Acquisition links of audio editions are one per file; OPDS 1.2 has no multi-file audiobook model, so a reader that does not play audio ignores them.
