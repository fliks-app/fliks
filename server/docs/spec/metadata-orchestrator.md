# Spec: metadata providers behind one trait, the rate limiter, snapshots and the field merge

Scope: how the server reaches a metadata provider. The per-provider mappings stay in `metadata.md` (TMDB, TVDB) and `book-providers.md` (books). Out of scope here: the book providers (1.2).

## Provider trait

1. `MetadataProvider` (`crates/server/src/metadata/provider.rs`) is the only surface the media, persons, requests and route code uses to ask a provider something. It is dyn-safe: every async method returns a `BoxFuture`, like `net::guard::Net`.
2. Methods: `id()` (the registry key, an `ExternalProvider`, as `preferredProvider` stores it), `supports(kind)`, `has_persons()`, `limits()`, `search`, `fetch_work`, `fetch_children`, `child_stubs`, `find_by`, `fetch_person`, `person_credits`. Each call carries the resolved language and a `Priority`. `limits()` is the limits the provider's limiter holds now.
3. Records are the JSON shapes `metadata.md` rules 24, 25, 31, 32 and 34 already describe: nothing about the wire or the mappings changes. `find_by(source, id)` answers `(id, kind)` or `None`; a source the provider cannot look up is `None` without a call (TMDB looks up IMDb and TVDB ids, TVDB looks up IMDb ids).
4. A provider id is a string. TMDB and TVDB parse it as an integer; callers validate it before the call (`metadata.md` rule 39), so an unparsable id never reaches a provider.
5. `metadata::types::Provider` does not exist: `ExternalProvider` is the provider name everywhere (`tmdb`, `tvdb`).
6. TMDB's lists (trending, popular, upcoming, genres, discover) are not part of the trait: no other provider has them. They stay methods of the TMDB client, with the stale list cache of `metadata.md` rule 17 unchanged.
7. The TVDB login single-flight (`metadata.md` rule 19) stays inside the TVDB client. The login is always sent at interactive priority: the login lock is held across it and must not wait behind a background pause.
8. TMDB `seasons` drops a season whose own call fails (`metadata.md` rule 31), except when the answer is a 429 or a 503, or the limiter refused the call: then the whole call fails, because a shortened list makes identify delete the seasons that are missing from it.

## Registry

9. `Metadata` holds one `Arc<dyn MetadataProvider>` per built-in provider and whether its key is configured (`metadata.md` rule 20). Both are always registered: TMDB is the default even without a key and a detail route does not check availability (`metadata.md` rules 6, 15, 20), so a keyless call still fails upstream as before.
10. `resolve(name)`: the named provider iff registered and available, else TMDB. `fallback(p, kind)`: the other provider iff available and `supports(kind)`. `person_fallback(p)`: the other provider iff available and `has_persons()`. Rules 6 and 8 of `metadata.md` are unchanged.

## Priority

11. `Priority` is `Interactive` or `Background`. A caller a person waits for is interactive: the `/api/metadata/*` routes, the person detail refresh and provider credits, `POST /api/media/import`, `POST /api/media/import/tmdb`, identify and the refresh routes, `POST /api/requests` (the auto-approval facts, the artwork and the auto-approve import), the admin approval of a request, and the single orphan relink (its import and its episode refresh). Everything else is background: the `RefreshMetadata` and `RefreshMissingMetadata` jobs, the importers, the batch orphan relink, the rescan episode refresh.
12. `service::import`, `for_media`, `seasons_for_media` and `episode` take the priority of their caller.

## Limiter

13. `fliks_domain::metadata::limiter::Limiter` is a pure state machine with an injected clock, like the breaker. `Limits { rate_per_sec, burst, daily_quota, background_share }` is what a provider declares; nothing is user-tunable. `set_limits` changes the limits of a running limiter (tokens, pause and day counter stay); a client calls it through `Guarded::set_limits` or its observer.
14. Two token buckets per provider. The shared one has `rate_per_sec` and `burst`; the background one has `rate_per_sec * background_share` (default 0.75) and the same burst. An interactive call takes one token from the shared bucket; a background call takes one from both. The background side never uses more than its share of the rate, and the interactive side can use all of it when the background is idle.
15. `take(now_ms, day, priority)` is `Ok(())` or `Err(Refused)`: `Wait(ms)` until a token (or the end of a pause) is available, or `QuotaSpent`. A refused call takes and counts nothing; an accepted one is counted against the quota of `day` in the same step.
16. `pause_until(now_ms, until_ms)` stops every taker until `until_ms`, at most 5 minutes after `now_ms`, and empties both buckets so the pause does not end on a burst. `backoff(now_ms)` pauses for 1 s, doubling on each consecutive throttle up to 60 s, and returns the delay; a throttle that arrives inside a pause already running costs no step and returns what is left of it. `reset_backoff()` follows any answer that is not a throttle.
17. Daily quota: a UTC day counter. `quota_left(day)` is `None` without a quota, else what remains; `on_quota_exhausted(day)` marks the day spent, quota or not. A new day resets both. The counter is in memory: a restart forgets it, and the provider's own refusal marks the day again. A client marks the day through its observer: `Guarded::with_observer` reads the status and headers of every response and returns `Observed { limits, quota_spent }` (for example from `x-ratelimit-*`).
18. There is one limiter per provider in the process, inside `http::Guarded::send`, after the breaker. A call first asks the breaker (a rejected call takes no token), then waits for a token (`tokio::time::sleep`) or fails on the quota, then sends.
19. Quota spent: the call fails at once with `Upstream` status 429, without a request, until the next UTC midnight.
20. HTTP 429 and 503 are throttle answers. `Retry-After` (delta-seconds or an HTTP date) pauses the limiter until then; without it the call backs off from 1 s up to 60 s. Then:
    - a background call retries after the pause, at most 3 times;
    - an interactive call retries at most once, and never waits more than 5 s in total (token waits and pauses together);
    - a call that cannot retry, or whose retry is refused for the budget or the quota, fails with the `Upstream` of the throttle answer it got; with no answer yet it fails with a 429 `Upstream`. Routes map it to 503 (`metadata.md` rule 41).
21. The breaker records one outcome per call, the last attempt's, so a retried 429 counts once. It counts 429 and 5xx as transient (`metadata.md` rule 18) and stays the last line.
22. Starting limits: TMDB 40 req/s, burst 40; TVDB 10 req/s, burst 10; neither has a daily quota. A call that waited more than a second logs one warning per process and provider.

## Fields and merge

23. `fliks_domain::metadata::field::Field` is the closed set of fields a provider record fills, checked in Rust (a `CHECK` would need a migration per field). Each owns the record keys of `metadata.md` rules 24, 25, 31 and 32 listed here:

    | Field | Record keys |
    |---|---|
    | `title` | `title` |
    | `originalTitle` | `originalTitle` |
    | `overview` | `overview` |
    | `year` | `year` |
    | `posterUrl` | `posterUrl` |
    | `fanartUrl` | `fanartUrl`, `additionalFanartUrls` |
    | `logoUrl` | `logoUrl` |
    | `rating` | `rating` |
    | `genres` | `genres` |
    | `runtime` | `runtime` |
    | `status` | `status` |
    | `alternativeTitles` | `alternativeTitles` |
    | `releaseDates` | `releaseDate`, `inCinemas`, `digitalRelease`, `physicalRelease` |
    | `collection` | `tmdbCollectionId`, `tmdbCollectionName` |
    | `credits` | `cast`, `crew` |
    | `details` | `budget`, `revenue`, `tagline`, `popularity`, `voteCount`, `originalLanguage`, `productionCountries`, `productionCompanies`, `videos`, `keywords` |
    | `ids` | `tmdbId`, `tvdbId`, `imdbId` |

    A key no field owns (`provider`, `mediaType`, `genreIds`, `seasonCount`, `episodeCount`) is merged by the same order and has no provenance.
24. A value is empty when it is `null`, `""` or `[]`; under `ids` a `0` is empty too (TVDB answers `tmdbId: 0` for a title it has no TMDB link for).
25. `merge(records, order, locked)` takes `(ExternalProvider, Map)` records, a `FieldOrder` and the locked fields, and answers the merged map and the provenance `[(Field, ExternalProvider)]`:
    - the keys of a field merge independently: for each, the first provider of the field's order whose record has a non-empty value wins; when none has, the first record that has the key supplies it as it is, so one record merges to itself, `null` and `""` included;
    - a locked field's keys are left out of the map and the provenance;
    - the provenance names, for every unlocked field with a non-empty winner, the provider of its first non-empty key in the order of rule 23.
26. `FieldOrder::new(kind, first)`: the providers of `first` (the season's, the media's, the library's preferred provider, most specific first), then the kind's default `[tmdb, tvdb]`, duplicates dropped. `providers()` is that order, the same for every field.
27. Video reads one provider per media (`metadata.md` rule 46), so the merge there is over one record and is the identity: refresh and import write what they wrote before. An import whose library prefers another provider (`metadata.md` rule 49) merges `[(preferred, its record), (found, the finder's record restricted to the `ids` keys)]`: every field comes from the preferred record, and an id it lacks comes from the finder's. Merging whole video records from several providers is a later switch.
28. Golden vectors: `fixtures/metadata-merge/cases.json` (`BLESS=1`): one record, two records with gaps, a locked field, an empty list against a missing key, the ids merge of rule 27.

## Snapshots

29. `metadata_snapshots(provider, resource, kind, "externalId", language, body, "fetchedAt", "expiresAt")`, `PRIMARY KEY (provider, resource, kind, "externalId", language)`, an index on `"expiresAt"`. `resource` is `work` or `children` (`person` and `chapters` come with the book providers); `kind` is the media kind the id is read as (TMDB numbers movies and shows apart); `language` is the resolved TMDB locale (`fr-FR`). `body` is the provider's mapped record, or the mapped list for `children`, never the raw HTTP body. `"expiresAt"` is `NULL` for a record that never expires. For books `resource` also takes `edition` and the `person` and `chapters` of `book-metadata.md` rule 6.
30. `Metadata::work` and `Metadata::children` (the media services' reads of `fetch_work` and `fetch_children`) go through `snapshot(key, priority, ttl, fetch)`: a row not expired answers without a call; otherwise the call runs and, unless the TTL is zero, the row is upserted with `"expiresAt" = now() + ttl`. The routes under `/api/metadata/*` and the request facts keep calling the provider.
31. `MetadataProvider::snapshot_ttl()` is `Some(ttl)` or `None` (never expires); the default is `Some(0)`, which TMDB and TVDB keep: every refresh still calls the provider, and no row is written since nothing would read it. A provider failure fails the call whatever snapshot exists (`metadata.md` rule 45).
32. Single-flight: concurrent calls for one `(provider, resource, kind, id, language)` and one priority share one provider call; an interactive and a background caller never share, since the priority decides how the limiter retries. The call runs in its own task, so a caller that gives up or a panic leaves no stale entry: the entry is removed when the task ends, a panic answers an `Upstream`, and the task stores the snapshot once. A failed snapshot write is logged and never fails a call whose fetch succeeded.
33. The `RefreshMetadata` job (04:00, `scheduler.md` rule 23) first deletes the snapshots whose `"expiresAt"` is older than 30 days; a failure of that delete is logged and does not stop the refresh.

## Provenance and locks

34. `media_field_sources("mediaId", field, provider, locked, "updatedAt")`, `PRIMARY KEY ("mediaId", field)`, `FOREIGN KEY ("mediaId") REFERENCES media (id) ON DELETE CASCADE`. `field` is a `Field` name, checked in Rust; `provider` is `NULL` when the value was set by hand; `locked` defaults to `false`. No row is backfilled: a media never refreshed has none, which reads as an unknown source.
35. `refreshMetadata` replaces the media's rows that are not locked with the provenance of rule 25, in the transaction that writes the media columns; the import writes them in the transaction that inserts the media. A locked row is never touched.
36. A locked field keeps its stored value: the merge leaves it out and the writers skip it. `title`, `originalTitle`, `status`, `genres` and `alternativeTitles` keep their column (`COALESCE` over a `NULL` parameter); `year`, `overview`, `posterUrl`, `logoUrl`, `rating` and `runtime` already keep theirs on a `NULL`; `fanartUrl` also keeps `additionalFanartUrls`; `releaseDates` keeps the stored dates; `collection` keeps the media's collection entries; `details` keeps the detail row; `credits` leaves the persons and `media_credits` untouched; `ids` keeps the external ids. Seasons and episodes have no field and are not locked.
37. Nothing sets a lock: `PUT /api/media/:id` keeps its meaning (an edit is overwritten at the next refresh) and there is no lock route. The table and the rule are tested with seeded locks.

## Migration

38. `1789000000130_metadata-snapshots.sql` creates `metadata_snapshots` and `media_field_sources`. Tables only; the wire is unchanged.

## Tests

Rust unit tests: the limiter scripted over a fake clock (burst then steady rate, background capped at its share while interactive passes, pause and its emptied buckets, backoff doubling, reset and one step per pause, quota spent then reset at UTC midnight, refused calls not counted, new limits, 100 background calls never above the rate); `Guarded` against a stub answering 429 with and without `Retry-After`, 503 and `Retry-After: 0`, on a fake clock with no real sleep (background retry and cap, interactive single retry and 5 s budget, the throttle answer returned when the budget runs out, spent quota without a request, the observer, an open breaker taking no token); TMDB `seasons` against a stub (a missing season dropped, a throttled one failing the list); the `Retry-After` parser.

Domain: the merge over the golden vectors of rule 28, plus unit tests of the empty rule and of `FieldOrder`. Integration (`tests/it/metadata.rs`): a second `snapshot` inside its TTL makes no call and one past it does, concurrent calls make one, a call whose callers all gave up leaves no stale entry, a panicking call answers an error and frees its key, an interactive and a background caller do not share a call, a refresh calls TMDB every time and leaves the provenance rows and no snapshot, a locked `overview` and a locked `credits` survive a refresh, the cleanup. `tests/it/migrations.rs`: the two tables.
