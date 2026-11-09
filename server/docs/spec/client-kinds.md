# Spec: client-declared kinds (`X-Fliks-Kinds`)

A released client crashes on a media kind it does not render, so the server sends a client only the kinds it declares. Scope: every authenticated `/api` route that returns media of several kinds. Implementation: `crates/server/src/http/kinds.rs`, carried as `Authed.kinds`.

## Rules

1. Header `X-Fliks-Kinds: movie,series,book,comic,album`: a comma list of kind names (`MediaKind` wire names), lower-case, repeated headers joined. Names are trimmed and lower-cased; an unknown name is ignored.
2. A request without the header, or whose header holds no known name, declares `{movie, series, book, comic}`: released 6.0.x clients render books and comics but send no header. A 5.x client may fail on a book; that is accepted. `album` stays hidden from such a client.
3. A caller that is no client of the web API (device tokens of OPDS, Kobo and kosync, which resolve `Authed::load`; background work) declares every kind. `/rest` (OpenSubsonic), the OPDS, Kobo and kosync routes, the engine and stream routes and `/engine/*` ignore the header.
4. Media of an undeclared kind (`media.type`) is absent from every route of rule 5. A count drops the same rows. Nothing else changes: the shape of a returned row is the same, and a declared kind is filtered by the ACL as before.
5. Filtered routes:
   - `GET /api/media`, `/recently-added`, `/genres`, `/collections`, `/counts` (the count of an undeclared kind is `0`), `/counts-by-library`, `/calendar` (events of undeclared kinds omitted), `/leaving-soon`; `GET /api/counts` (`mediaByLibrary`, `pendingRequests`).
   - `GET /api/media/:id` and its read sub-routes `/tracking`, `/similar`, `/collection`, `/cast`, `/crew`, `/streams/:fileId`, `/editions/:id/chapters`: a media of an undeclared kind is `404 Media #<id> not found`, as an inaccessible one.
   - `GET /api/playback/continue-watching`, `/history`, `/recommendations` (candidates).
   - `GET /api/likes`, `GET /api/social/recommendations`, `/received`, `/sent`, `GET /api/social/users/:id/profile` (recommendations, recently watched, likes, playlists).
   - `GET /api/playlists`, `/:id` (`itemCount`, `posters`; a smart playlist, which holds album tracks only, is empty without `album`), `/:id/items`.
   - `GET /api/requests` (by the request's `mediaType`), `GET /api/wanted`.
   - `GET /api/collections`, `/:id` (entries of undeclared kinds omitted).
   - `GET /api/persons` (`role` author and narrator need `book`, artist and composer need `album`, else `[]`), `/:id` credits and `/:id/provider-credits` links (`media`, `mediaId` omitted or `null`), `/:id/works` (needs `book`), `/:id/bibliography` (needs `book`, else `[]`), `/:id/discography` (owned albums need `album`).
   - `GET /api/libraries` and `GET /api/libraries/mine`: a library whose `mediaTypes` is non-empty and holds no declared kind is omitted. A library page (`GET /api/media?libraryId=`) of such a library is an empty result (the media of its kinds are filtered, rule 4), not a 404.
6. Deliberately not filtered, because no client of an older release reaches them or they need every kind:
   - admin and settings routes (`GET /api/libraries/:id`, `/api/system/*`, jobs, queue, optimize, cleanup rules and candidates, importers, the write routes `POST|PUT|PATCH|DELETE /api/media/*`);
   - routes addressed by an explicit kind (`/api/metadata/*`, `/api/music/*`, `/api/works`, `/api/media/:id/music/*`), the playlist M3U export, `/api/playback/media/:id*` and `/api/playback/watched-ids` (per-media state by id), the watch party routes and the SSE stream.
7. Clients: the web client sends the header from its HTTP interceptor with the kinds of its registry; the tvOS app sends the kinds of its `MediaKind`.
