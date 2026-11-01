# Spec: metadata providers behind one trait, and the rate limiter

Scope: how the server reaches a metadata provider. The per-provider mappings stay in `metadata.md` (TMDB, TVDB) and `book-providers.md` (books). Out of scope here: snapshots, field merge, provenance and locks (the orchestrator, 0.11b), and the book providers (1.2).

## Provider trait

1. `MetadataProvider` (`crates/server/src/metadata/provider.rs`) is the only surface the media, persons, requests and route code uses to ask a provider something. It is dyn-safe: every async method returns a `BoxFuture`, like `net::guard::Net`.
2. Methods: `id()` (the registry key, an `ExternalProvider`, as `preferredProvider` stores it), `supports(kind)`, `limits()`, `search`, `fetch_work`, `fetch_children`, `child_stubs`, `find_by`, `fetch_person`, `person_credits`. Each call carries the resolved language and a `Priority`.
3. Records are the JSON shapes `metadata.md` rules 24, 25, 31, 32 and 34 already describe: nothing about the wire or the mappings changes. `find_by(source, id)` answers `(id, kind)` or `None`; a source the provider cannot look up is `None` without a call.
4. A provider id is a string. TMDB and TVDB parse it as an integer; callers validate it before the call (`metadata.md` rule 39), so an unparsable id never reaches a provider.
5. `metadata::types::Provider` does not exist: `ExternalProvider` is the provider name everywhere (`tmdb`, `tvdb`).
6. TMDB's lists (trending, popular, upcoming, genres, discover) are not part of the trait: no other provider has them. They stay methods of the TMDB client, with the stale list cache of `metadata.md` rule 17 unchanged.
7. The TVDB login single-flight (`metadata.md` rule 19) stays inside the TVDB client.

## Registry

8. `Metadata` holds one `Arc<dyn MetadataProvider>` per built-in provider and whether its key is configured (`metadata.md` rule 20). Both are always registered: TMDB is the default even without a key and a detail route does not check availability (`metadata.md` rules 6, 15, 20), so a keyless call still fails upstream as before.
9. `resolve(name)`: the named provider iff registered and available, else TMDB. `fallback(p, kind)`: the other provider iff available and `supports(kind)`. Rules 6 and 8 of `metadata.md` are unchanged.

## Priority

10. `Priority` is `Interactive` or `Background`. A caller a person waits for is interactive: the `/api/metadata/*` routes, the person detail refresh and provider credits, `POST /api/media/import`, `POST /api/media/import/tmdb`, identify and the refresh routes. Everything else is background: the `RefreshMetadata` and `RefreshMissingMetadata` jobs, request approval imports and their title facts, the importers, ingest (relink, rescan episode refresh).
11. `service::import`, `for_media`, `seasons_for_media` and `episode` take the priority of their caller.

## Limiter

12. `fliks_domain::metadata::limiter::Limiter` is a pure state machine with an injected clock, like the breaker. `Limits { rate_per_sec, burst, daily_quota, background_share }` is what a provider returns from `limits()`; nothing is user-tunable.
13. Two token buckets per provider. The shared one has `rate_per_sec` and `burst`; the background one has `rate_per_sec * background_share` (default 0.75) and the same burst. An interactive call takes one token from the shared bucket; a background call takes one from both. The background side never uses more than its share of the rate, and the interactive side can use all of it when the background is idle.
14. `take(now_ms, priority)` is `Ok(())` or `Err(WaitMs)`: the time until a token (or the end of a pause) is available. Nothing is taken on `Err`.
15. `pause_until(now_ms, until_ms)` stops every taker until `until_ms`, at most 5 minutes after `now_ms`. `backoff(now_ms)` pauses for 1 s, doubling on each consecutive call up to 60 s, and returns the delay; `reset_backoff()` follows any non-throttled answer.
16. Daily quota: a UTC day counter. `quota_left(day)` is `None` without a quota, else what remains; `count_call(day)` spends one; `on_quota_exhausted(day)` marks the day spent when the provider says so. A new day resets both. The counter is in memory: a restart forgets it, and the provider's own refusal marks the day again.
17. There is one limiter per provider in the process, inside `http::Guarded::send`, before the breaker. A call first checks the quota, then waits for a token (`tokio::time::sleep`), then asks the breaker, then sends.
18. Quota spent: the call fails at once with `Upstream` status 429, without a request, until the next UTC midnight.
19. HTTP 429 and 503 are throttle answers. `Retry-After` (delta-seconds or an HTTP date) pauses the limiter until then; without it the call backs off from 1 s up to 60 s. Then:
    - a background call retries after the pause, at most 3 times, then fails with the `Upstream` it got;
    - an interactive call never waits more than 5 s in total (token waits and pauses together): a wait that would pass it fails at once with the `Upstream` the call got, or with a 429 `Upstream` when no answer came yet. Routes map it to 503 (`metadata.md` rule 41).
20. The breaker records one outcome per call, the last attempt's, so a retried 429 counts once. It counts 429 and 5xx as transient (`metadata.md` rule 18) and stays the last line.
21. Starting limits: TMDB 40 req/s, burst 40; TVDB 10 req/s, burst 10; neither has a daily quota. A call that waited more than a second logs one warning per process and provider.

## Tests

Rust unit tests: the limiter scripted over a fake clock (burst then steady rate, background capped at its share while interactive passes, `pause_until`, backoff doubling and reset, quota spent then reset at UTC midnight, 100 background calls never above the rate); `Guarded` against a stub answering 429 with and without `Retry-After` and a 503, an interactive call giving up after 5 s, a background call giving up after 3 retries, a spent quota skipped without a request, all on a fake clock with no real sleep; the `Retry-After` parser.
