# Spec: metadata providers behind one trait, and the rate limiter

Scope: how the server reaches a metadata provider. The per-provider mappings stay in `metadata.md` (TMDB, TVDB) and `book-providers.md` (books). Snapshots, field merge, provenance and locks, and the book providers, are specified with the orchestrator and the book clients.

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

## Tests

Rust unit tests: the limiter scripted over a fake clock (burst then steady rate, background capped at its share while interactive passes, pause and its emptied buckets, backoff doubling, reset and one step per pause, quota spent then reset at UTC midnight, refused calls not counted, new limits, 100 background calls never above the rate); `Guarded` against a stub answering 429 with and without `Retry-After`, 503 and `Retry-After: 0`, on a fake clock with no real sleep (background retry and cap, interactive single retry and 5 s budget, the throttle answer returned when the budget runs out, spent quota without a request, the observer, an open breaker taking no token); TMDB `seasons` against a stub (a missing season dropped, a throttled one failing the list); the `Retry-After` parser.
