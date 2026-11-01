# Spec: persons (`/api/persons/*`)

Scope: the three persons routes. Provider clients and the language cache are `metadata.md` (cited "meta rule N"); the image pipeline is `image-store.md` ("img rule N"); the serialised `Media` entity is `media-query.md` rules 30-31; auth, validation and error-body rules are in `auth.md` ("auth rule N"); library ACL is `libraries.md` rules 30-36. 4xx/5xx `Cache-Control: no-store` = `bootstrap.md` rule 7. Client: `client/src/app/core/services/api/persons-api.service.ts` (all three routes, behind `authGuard`).

## Routes

3 routes. All require authentication (`Authed`, no policy, like `AnyAuthenticatedUser`): anonymous 401 (auth rule 14), `scope:'stream'` token 401 (stream tokens are accepted only on media delivery routes, `auth.md`). No success status override (GET = 200). `search` is a static segment, so it is never read as an id (axum static-over-param).

`Person` = the `persons` row without `searchVector`, plus the id it is shown with (view `person_ids`, section "Credits and person ids"): `{id, createdAt, updatedAt, provider: string|null, tmdbId: number|null, name: string, avatarUrl: string|null, biography: string|null, birthday: string|null ('YYYY-MM-DD'), deathday: string|null, placeOfBirth: string|null, knownForDepartment: string|null, departments: string[], metadataRefreshedAt: string|null (ISO)}`; timestamps in the `%Y-%m-%dT%H:%M:%S%.3fZ` form (media-query rule 30). `MediaRow` = `Media` as `media-query.md` rule 30 (all columns, `path`, joined `library`, `qualityProfile`, `languageProfile`) plus `metadata` (rule 31, `media_details_json`, bigints as strings); no `files`, `seasons`, `cast`, `crew`, `addedBy`, `episodeStats`, `watched`, `progressPercent` (rule 17).

| Method path | Auth | Request | Response | Errors | Side effects |
|---|---|---|---|---|---|
| `GET /api/persons/search` | authenticated, no policy | query `q?` string, unknown keys ignored (rules 2-6) | 200 `Person[]` (rule 7) | 401; 400 when `q` is repeated (rule 2) | none |
| `GET /api/persons/:id` | same | path `id`: canonical `i32` (rule 8) | 200 `{person: Person, cast: CastRow[], crew: CrewRow[]}` (rules 9-17) | 400 `Validation failed (numeric string is expected)`; 404 `Person #<id> not found` `{message, error:"Not Found", statusCode:404}`; provider and image failures never surface (rule 13) | may UPDATE `persons` and write 2 image files (rules 9-12) |
| `GET /api/persons/:id/provider-credits` | same | path `id` as above | 200 `{provider: string|null, cast: Credit[], crew: Credit[]}` (rules 19-21) | 400 / 404 as above; upstream failure 503 `Metadata request failed on <provider>: <reason>` | may UPDATE `person_external_ids.provider` (rule 11) |

`CastRow` = `{id, createdAt, updatedAt, character: string, order: number, media: MediaRow, person: Person}`; `CrewRow` = `{id, createdAt, updatedAt, job: string, department: string, media: MediaRow, person: Person}` (every row repeats the full person, including its refreshed fields). `Credit` = `{externalId: number, title: string, mediaType: 'movie'|'series', character?: string, job?: string, department?: string, posterUrl: string|null, fanartUrl?: string|null, releaseDate: string|null, rating: number, mediaId: number|null}` (`character` on cast items, `job` + `department` on crew items; absent keys are absent, see meta rule 34).

## Rules

### A. Search

1. Authentication is required on all three routes. The client sends a credential on each; Apple TV, Cast and Electron main do not call these routes.
2. `q` is an optional query string: a missing, empty or whitespace-only `q` lists persons (rule 3); a repeated `q` is 400 (standard validation body).
3. Empty or blank `q`: the first 1000 persons ordered by `name ASC, id ASC`, no pagination, so a large catalog does not ship every biography in one response (a person past the cap is still found by name).
4. Non-empty `q`: the trimmed `q` is split on whitespace; each word is a prefix term, all words ANDed, `p."searchVector" @@ to_tsquery('simple', $1)`, config `simple` (no stemming, no stop words, lowercase).
5. Words are sanitised before they reach `to_tsquery`: each word is reduced to its letter/digit/`-`/`_` runs, empties are dropped, and each run is quoted as a lexeme with `:*`. Operators are never interpreted (`a&`, `x!`, `(`, `a|b`, `!a` are plain text), `o'brien` and `jean-luc` still match "O'Brien" and "Jean-Luc" (`jean-luc` → `'jean-luc':* <-> 'jean':* <-> 'luc':*`), and a `q` with no usable word answers `[]`.
6. Order and size: `ORDER BY ts_rank(p."searchVector", to_tsquery('simple', $1)) DESC, p.name ASC, p.id ASC LIMIT 50`. `searchVector` is NULL only for a person never indexed, which never matches (rule 22).
7. Result = `Person[]` (`searchVector` never selected). Empty result `[]`.

### B. Detail (`GET :id`)

8. `:id` must be a canonical integer within `i32` (`7`, `-7`; never `007`, `1e1`, ` 7 `, `+7`, `0x7`), else 400.
9. `findOne(id)`: `SELECT … FROM persons WHERE id = $1`; missing → 404 `Person #<id> not found`. Then the detail refresh runs **inside the request** before the cast/crew queries (latency = provider call, up to 10 s TMDB / 15 s TVDB, plus the avatar download up to 15 s after waiting for a slot of the image store's download semaphore).
10. Refresh condition: `metadataRefreshedAt` is `null` or older than **7 days**; otherwise nothing is fetched and the stored row is returned as is. Persons created by a media import therefore have no biography until the first `GET :id`.
11. Provider routing (shared with `provider-credits`): the person's id row (`person_external_ids`) names the provider that issued the id (`tmdb` default, `tvdb` for TVDB credits, unique on `(provider, value)`); the registry picks it iff its key is configured, else TMDB (meta rule 6, so a `tvdb` person with no TVDB key is asked of TMDB). The id sent is the decimal string of the id value. When the call fails with an **HTTP 404** (the id belongs to the other provider) and another provider is available, the same call is made there; on success the id row is pinned to it (`UPDATE person_external_ids SET provider = <fallback>` and the in-memory person), one log line. Any other error (timeout, 5xx, 429, breaker open, non-404 4xx, fallback also failing) is rethrown. If the pin violates `UNIQUE (provider, value)` (another person already holds that pair) the row keeps its provider and the data is still served (credits returned, refresh applied) instead of failing.
12. Avatar: when `details.avatarUrl` is set, the image store (img rules 1-15) stores `<dataDir>/persons/<id>.jpg` (+ `-thumb`, no `-medium`, `person: {thumb: w45, full: original}`); the returned `/api/images/person/<id>?v=<hash>` becomes `avatarUrl`; a `null` result (download or decode failed) leaves the existing `avatarUrl` untouched and the provider's URL is **never stored**.
13. The whole refresh is best-effort: provider failure and image failure and a failing UPDATE are all swallowed, nothing is logged by this code, `metadataRefreshedAt` is unchanged, and the stored row is served. While the provider is unreachable **every** `GET :id` of a stale person pays the full timeout (TMDB's breaker, meta rule 18, makes it fast after 3 failures; TVDB has none); the refresh stays synchronous.
14. Update set: `name: details.name`, `avatarUrl` only when rule 12 produced a local path, `biography: details.biography` (string, `''` allowed), `birthday`, `deathday`, `placeOfBirth` only when the provider answers a value (a provider that answers `null` **never clears** a stored value), `knownForDepartment: details.knownForDepartment`, `metadataRefreshedAt` set to the current time; `updatedAt` is set by the `updatedAt` trigger. `departments` is not touched. The `searchVector` trigger (rule 22) re-indexes a changed `name`.
15. Response of the refreshing request: the row re-read after the update (keys `null` when unset, fresh `updatedAt`), so it has the same shape as every later response; the client reads `string|null`.
16. Concurrent `GET :id` of one stale person: each request runs its own provider call; only the image store de-duplicates (img rule 2), the later UPDATE wins. No lock.
17. Cast/crew (after the refresh): the person's `media_credits` rows with role `cast` and with role `crew`, each ordered `position ASC, id ASC`, are read concurrently (SQL Q3/Q4); the wire `order` of a cast row is `position`. Each `media` joins its `library`, `qualityProfile`, `languageProfile` and `metadata`, so it is the entity of media-query rule 30 + `metadata` (rule 31). The library ACL of rule 21 filters the rows: cast/crew rows of media in libraries the caller cannot read are omitted, and `media.path` / `media.library.path` are omitted for callers who cannot manage libraries (same predicate as `media-query.md` rule 73).
18. A person with no credits answers `cast: []`, `crew: []`. A person without an id row is served as stored, never refreshed, and `provider-credits` answers `{provider: null, cast: [], crew: []}` for it; a provider other than `tmdb`/`tvdb` cannot be stored (`CK_person_external_ids_provider`).

### C. Provider credits (`GET :id/provider-credits`)

19. `findOne` (no avatar, no row refresh, 404 as above), then the provider's `getPersonCredits(<tmdbId as string>)` (rule 11, including the 404 fallback and provider pin). Provider payload: meta rule 34 (TMDB `combined_credits`: `title = title ?? name ?? ''`, `mediaType = media_type === 'tv' ? 'series': 'movie'`, `releaseDate = release_date ?? first_air_date ?? null`, `rating = vote_average ?? 0`, `posterUrl w500`, `fanartUrl original`). An upstream failure is 503 `Metadata request failed on <provider>: <reason>` (shared with `metadata.md` rule 39).
20. Credits are mapped to `{...item, mediaId: null}` then linked to owned media (SQL Q5): ids = distinct truthy `externalId`s of cast + crew; none → no query; `provider = person.provider` (`tvdb` or `tmdb`, the **pinned** provider, after rule 11); the media holding one of `ids` for that provider are read from `media_external_ids` with their kind and value; the link is keyed `(type, id)` using the credit's `mediaType`, so a TMDB movie and series that share a numeric id link to the right media. No match → `mediaId: null`.
21. Library ACL: `mediaId` in provider credits, and `media` in `CastRow`/`CrewRow` (rule 17), only for media in libraries the caller can read (`libraries.md` rules 30-36; admin and `manage:all` see all); credits for other media keep `mediaId: null`, cast/crew rows for other media are omitted, and `media.path` / `media.library.path` are omitted for callers who cannot manage libraries (same predicate as `media-query.md` rule 73), as on `metadata.md` rule 38.
22. `searchVector` maintenance: a `BEFORE INSERT OR UPDATE OF name` trigger sets `"searchVector" = to_tsvector('simple', name)`, with a backfill at migration time, and `idx_persons_search_vector` (GIN on `"searchVector"`) serves the search. The media metadata import creates persons and never writes `searchVector` itself; a name changed by `GET :id` is re-indexed by the same trigger.

## SQL

- **Q1 search all** (rule 3): `SELECT id, "createdAt", "updatedAt", x.provider, x.value::int AS "tmdbId", name, "avatarUrl", biography, birthday, deathday, "placeOfBirth", "knownForDepartment", departments, "metadataRefreshedAt" FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id ORDER BY name ASC, id ASC LIMIT 1000`.
- **Q1b search** (rules 4-6): same columns `FROM persons p LEFT JOIN person_ids x ON x."personId" = p.id WHERE p."searchVector" @@ to_tsquery('simple', $1) ORDER BY ts_rank(p."searchVector", to_tsquery('simple', $1)) DESC, p.name ASC, p.id ASC LIMIT 50`.
- **Q2 one person** (rule 9): `SELECT <columns> FROM persons WHERE id = $1`; id: `LEFT JOIN person_ids x ON x."personId" = persons.id` (`x.provider`, `x.value::int`); refresh write: `UPDATE persons SET name=$, "avatarUrl"=$, biography=$, birthday=$, deathday=$, "placeOfBirth"=$, "knownForDepartment"=$, "metadataRefreshedAt"=$, "updatedAt"=now() WHERE id = $` with the unset columns left out (rule 14), followed by a re-read (rule 15); provider pin: `UPDATE person_external_ids SET provider = $2 WHERE "personId" = $1 AND provider = $3`.
- **Q3 cast** (rule 17): `SELECT mc.id, mc."createdAt", mc."updatedAt", mc.character, mc.position, <media row + library + qualityProfile + languageProfile>, `media_details_json(m.id)` as `metadata`, <person row> FROM media_credits mc JOIN media m ON m.id = mc."mediaId" LEFT JOIN libraries l … JOIN persons p ON p.id = mc."personId" WHERE mc."personId" = $1 AND mc.role = 'cast' ORDER BY mc.position ASC, mc.id ASC` (`mc.position` serialised as `order`). `mediaId` and `personId` are `NOT NULL` with cascading FKs.
- **Q4 crew** (rule 17): same with `mc.role = 'crew'` selecting `job, department`, `ORDER BY mc.position ASC, mc.id ASC`.
- **Q5 owned media** (rule 20): `SELECT m.id, m.type, e.value FROM media_external_ids e JOIN media m ON m.id = e."mediaId" WHERE e.provider = $3 AND e.value = ANY($1) AND m."libraryId" = ANY($2) ORDER BY m.id ASC` (`$3` = `tmdb` or `tvdb`), keyed `(type, value)`.

## Credits and person ids

- `media_credits` holds every credit: `role` is `cast | crew | author | narrator | translator`; `character` is set for cast, `job` and `department` for crew (checked), `position` orders a media's credits of one role (the cast `order`, the crew list index). A credit belongs to a media; `editionId`, when set, narrows it to one edition of that media (a composite FK refuses another media's edition). Nothing writes it. No unique constraint: a provider may list one person twice in a title.
- `person_external_ids("personId", provider, value)` holds the ids, `PRIMARY KEY ("personId", provider)`, `UNIQUE (provider, value)`, provider `tmdb | tvdb`, value a positive decimal of at most nine digits. Every person the server creates has exactly one row; a TVDB person id and a TMDB one are separate namespaces, so the same number may exist under both providers for two persons.
- View `person_ids("personId", provider, value)` picks the id a person is shown with among the `tmdb` and `tvdb` rows (`tmdb` first), so a provider added later is never read as a number. It feeds the wire `provider` and `tmdbId`.
- Finding or creating persons for a credit list (matched by `(provider, value)`, the missing ones inserted with their id row; an id outside 1 to 999999999 is skipped, its credit dropped) runs in one transaction under `pg_advisory_xact_lock(hashtext('persons:' || provider))`, so two imports of overlapping casts yield one person per id.
- The credit rows of a media are replaced as a whole (role `cast` and `crew`, no edition) under the `FOR UPDATE` of its `media` row.

## Events

None emitted or consumed.

## Settings keys

None read by this domain directly. The provider language comes through the metadata clients (`metadata_language`, `metadata_region`, meta rule 23).

## Jobs/timers

None. The 7-day refresh is lazy, driven by `GET :id` (rule 10); there is no scheduled person refresh. The 04:00 `RefreshMetadata` job updates `persons.name` / avatars of cast members through the media import code (media spec), not this module.

## Vectors/parity

Rust tests in `crates/domain/src/persons.rs` cover the rules: the provider-call decision table (error kind × fallback availability → rethrow / retry on other provider / pin), owned-media linking (empty ids, duplicate ids, tmdb vs tvdb column, `(type, id)` collisions), the refresh-condition boundary (exactly 7 d), the update-set builder (unset vs `null`, rule 14) and the tsquery builder (`o'brien` and `Jean-Luc` match; `a&`, `a|b`, `!a`, `(`, `-`, accents, multiple spaces). No `server/fixtures` set exists for this domain.

External HTTP is always mocked: `GET /person/<id>` and `/person/<id>/combined_credits` TMDB fixtures, TVDB `/people/<id>/extended`, and `images/person-600x900.jpg` served as the avatar (a generated JPEG, never real artwork).

Seed delta (deterministic SQL, no external calls): ~12 persons (provider `tmdb` and `tvdb`; one with `metadataRefreshedAt` = fresh, one stale (> 7 d), one `NULL`; names with apostrophe, accent and hyphen; `searchVector` computed for all but one), `media_credits` rows across both libraries (`readonly` sees only one, `user` sees two), one TMDB id shared by a seeded movie and series.

Scenarios (`server/parity/scenarios/persons/`, 25 files, `as` in `admin|user|readonly|anon`): `search-prefix` (`q=cla` ranked, `LIMIT 50`), `search-multi-word`, `search-empty-lists-all` (order by name), `search-blank-spaces`, `search-none`, `search-accents`, `search-apostrophe`, `search-unauth` (401), `search-syntax-chars`, `detail-fresh` (no HTTP, mock hit counter 0), `detail-refresh-tmdb` (stale: biography/avatar updated), `detail-refresh-null-fields`, `detail-refresh-provider-fail` (mock 500: stale row served, `metadataRefreshedAt` unchanged), `detail-refresh-404-fallback` (TMDB 404, TVDB answers, `provider` pinned to `tvdb` on a following read), `detail-avatar-null` (image 404: avatarUrl unchanged), `detail-tvdb`, `detail-notfound` (404 body), `detail-bad-id` (`abc`, `007`, `1e1` → 400), `detail-unauth`, `detail-acl` (`as readonly`: restricted library credits omitted, `path` omitted), `credits-owned` (mediaId linked), `credits-404-fallback`, `credits-type-collision`, `credits-upstream-fail` (503), `credits-unauth`. Image file assertions (`persons/<id>.jpg` bytes equal the mock's, `persons/<id>-thumb.jpg` width 45, `persons/<id>.src.json`) are in the runner's `files` check for the refresh scenarios.

## Open questions

None.
