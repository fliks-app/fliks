# Spec: provider plugins

Scope: metadata providers as plugins. The `provider` manifest block, the `metadata-provider` WIT interface and its host imports, id namespaces open to third parties, the Fliks defaults a plugin reads, the outbound limiter and the provider lane, bundled providers. The plugin lifecycle, the manifest keys, the install pipeline and the WIT package are in `plugins.md` (this file is its section J); the trait the host adapts a provider to, the registry, the limiter and the snapshots are in `metadata-orchestrator.md`; the record shapes a provider returns are in `metadata.md` (rules 24, 25, 31, 32, 34) and `book-metadata.md`; id storage is in `external-ids.md`.

The pluginApi stays 3: the `metadata-provider` interface and the `provider` world are part of `fliks:plugin@3.0.0` from its first release.

## Model

1. A provider is a `process` plugin (wasm) whose manifest carries a `provider` block and whose component exports `fliks:plugin/metadata-provider@3.0.0` (the world `provider`, which is the world `plugin` plus that export). There is no third tier: `PluginSummary.kind` stays `data` or `process`, the role is read from the manifest. A manifest with a `provider` block and a component without the export, or the export without the block, fails registration `invalid-component` (`plugins.md` rule 7, step 10).
2. A provider holds no database: `database.schema` is `false` (any other value is `PLUGIN_BAD_MANIFEST`), `scopes` may be empty (rule 3 of `plugins.md` otherwise asks for one), and `config-get` needs no scope (it reads only the caller's own keys, `plugins.md` rule 24; `config-set` still needs `config:rw`). The host calls a provider on its `provider` lane (rules 50-53) and keeps its `core` lane for `hello` and `health`.
3. Official ids follow `fliks.download` and `fliks.notify`: `fliks.tmdb`, `fliks.tvdb`, `fliks.openlibrary`, `fliks.googlebooks`, `fliks.bnf`, `fliks.audible`, `fliks.audnexus`. They live in `fliks-app/plugins`, each with its own version and tag.
4. The core keeps what touches data integrity and indexes it by namespace (uniqueness, collections, the request title lock, the merge and its field orders, `metadata_snapshots`, `media_field_sources`); a provider only talks to its upstream API and maps the answer to the record shapes. The host adapter (`PluginProvider`) implements `MetadataProvider`, so the orchestrator, the snapshots, the single-flight and the merge do not change.

## Manifest block

`provider` is an object with these keys and no other, at most one block per manifest. Its shape is checked with the rest of the manifest (`PLUGIN_BAD_MANIFEST`, the vector set `plugin-manifest`); the namespace rules of 19-33 run at registration.

| Key | Required | Shape |
|---|---|---|
| `namespaces` | yes | 1 to 8 entries, no name twice. A core namespace: `{name}` alone. A plugin namespace: `{name, label, idPattern, case?}`, `label` 1 to 64 characters, `idPattern` a string (rule 20), `case` `preserve` (default), `lower` or `upper`. |
| `kinds` | yes | Object, at least one key from `movie series book comic album`; each value a non-empty array of distinct capabilities from `search work children childStubs edition chapters person credits findBy lists`. |
| `findBy` | no | Distinct namespace names the `find-by` call accepts as input. |
| `editionNamespaces` | no | Distinct namespace names `fetch-edition` accepts (ISBN, ASIN, OLID). |
| `chapterNamespaces` | no | Distinct namespace names `fetch-chapters` accepts (ASIN). |
| `limits` | yes | `{ratePerSec, burst, dailyQuota?, backgroundShare?}`: `ratePerSec` a number in (0, 1000], `burst` an integer 1 to 1000, `dailyQuota` null or an integer of at least 1, `backgroundShare` a number in (0, 1], default 0.75. |
| `requestTimeoutMs` | no | Integer 1000 to 60000, default 10000. |
| `snapshotTtlSecs` | no | Object over `work children edition person chapters`; each value null (never expires) or an integer of seconds, at most 315360000 (ten years); a missing resource is 0. |
| `imageHosts` | no | At most 16 distinct lowercase host names, each with a dot and no scheme, port, path or wildcard. |
| `requires` | no | Distinct config keys (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`, no `.`: a key with a dot is not one key of a plugin's own settings) that must resolve non-empty for the provider to be available (rule 41). |

Official block of a core namespace:

```json
"provider": {
  "namespaces": [{ "name": "tmdb" }],
  "kinds": {
    "movie":  ["search", "work", "person", "credits", "findBy", "lists"],
    "series": ["search", "work", "children", "childStubs", "person", "credits", "findBy", "lists"]
  },
  "findBy": ["imdb", "tvdb"],
  "limits": { "ratePerSec": 40, "burst": 40 },
  "requestTimeoutMs": 10000,
  "snapshotTtlSecs": { "work": 0, "children": 0 },
  "imageHosts": ["image.tmdb.org"],
  "requires": ["apiKey"]
}
```

A third-party provider with its own namespace (plugin id `org.example.anime`):

```json
"provider": {
  "namespaces": [
    { "name": "org.example.anime:aid", "label": "Example Anime DB", "idPattern": "^[1-9][0-9]{0,8}$", "case": "preserve" }
  ],
  "kinds": { "series": ["search", "work", "children", "findBy"] },
  "findBy": ["imdb", "tvdb"],
  "limits": { "ratePerSec": 1, "burst": 2 },
  "imageHosts": ["cdn.example.org"]
}
```

5. The first namespace is the provider's key in the registry: `preferredProvider`, the order per kind and `metadata_snapshots.provider` name it.
6. Capabilities of a kind map to the WIT functions: `search` to `search`, `work` to `fetch-work`, `children` to `fetch-children`, `childStubs` to `child-stubs`, `edition` to `fetch-edition`, `chapters` to `fetch-chapters`, `person` to `fetch-person`, `credits` to `person-credits`, `findBy` to `find-by`, `lists` to `list`. The host calls only what is declared: a call with a declared kind (`search`, `work`, `children`, `childStubs`, `lists`) needs the capability under that kind; `edition`, `chapters`, `person`, `credits` and `findBy` carry no kind and need it under any kind. The host answers an undeclared call `Upstream` status 404 without entering the component. `supports(kind)` is a key of `kinds`; `has_persons()` is `person` under any kind.
7. `findBy`, `editionNamespaces` and `chapterNamespaces` only say what the plugin reads as input; any namespace known to the core (rule 19) may be listed.
8. `limits`, `requestTimeoutMs` and `snapshotTtlSecs` replace the host constants `LIMITS`, `TMDB_TIMEOUT`, `TVDB_TIMEOUT` and `snapshot_ttl()`.
9. `imageHosts` is the only set of hosts from which the core downloads an image named by a record of this provider (rule 32).
10. Capabilities shown in the inspect report and the consent sheet (`plugins.md` rule 12): `namespace:<name>` per declared namespace, in order, then `provider:<first namespace>:<kind>` per kind, kinds sorted. They follow `network:internal`.
11. A new `namespace:` capability in an update holds it like a new scope (`plugins.md` rule 29).
12. `plugin.template.json` carries the same block; `fliks-plugin-sdk-provider` (`crates/plugin-sdk/provider`, next to the SDK because two `generate!` of one crate clash on their exported macros) holds the `MetadataProvider` guest trait and `export_provider!`, which export the world `provider`, `check_world` accepts the `metadata-provider` export when the manifest has the block and refuses it otherwise.

## Calls

The interface is the one in the WIT package of `plugins.md` (`metadata-provider`). Every record is a `json` document, not a typed record: the trait already speaks JSON, the merge works on maps, and typing the fields would freeze each one in the ABI.

13. Arguments: `kind` is a documented kind string; `lang` carries the resolved metadata language (`language`, `region`, `locale` = `tmdb_locale`); `search-query` mirrors the `Search` of the trait (`kind`, `query`, `year`, and for books `title`, `author`, `author-id`, `isbn`, `language`) plus a 1-based `page`. An id argument is an `external-id` of one of the provider's namespaces (`fetch-work`, `fetch-children`, `child-stubs`, `fetch-person`, `person-credits`), of `editionNamespaces` (`fetch-edition`) or of `chapterNamespaces` (`fetch-chapters`). `search-query.extra` is the extension slot: further search parameters by name, ignored by a provider that knows none. `find-by` answers the `external-id` (in one of the provider's namespaces) and kind it knows the work of `source` by, or none; `fetch-edition` and `fetch-chapters` answer none for an unknown edition. `list` takes a list name (`trending popular upcoming genres discover`), its string parameters and the kind.
14. Results: the host validates each record on receipt. It must parse as JSON, be at most 16 MiB, and be an object (an array for `search`, `fetch-children`, `child-stubs` and `list` where the metadata specs say array). Keys outside the `Field` set are ignored by the merge. A malformed record is `Upstream` status 502 and counts as a failure for the provider's breaker. Ids under `ids` are normalised by rule 28.
15. `provider-error` maps to `Upstream`: `not-found` to status 404, `unauthorized` to 401 (the provider stays registered; it is unavailable until its config changes), `rate-limited(retry)` to 429, and the host's limiter pauses for `retry` seconds when given, else as for a `Retry-After` it did not read (rule 54); `unsupported` to 404 like an undeclared call; `upstream({status, message})` to that status (none when the upstream gave none) with the message as reason (the host logs it; a plugin never puts a URL or a secret in it).
16. The priority does not cross the boundary. The host knows the priority of the export in progress and applies it to every outbound request of that export (rule 54).
17. `provider-set-limits(rate-per-sec, burst, daily-quota)` replaces the plugin's limiter limits (an upstream's `x-ratelimit-*` headers, the contact-email tier of OpenLibrary); `provider-quota-spent` marks the day's quota spent until midnight UTC. Both are for a plugin with a `provider` block and answer `ERR_DENIED` to any other. Values are checked as the manifest's `limits`; a bad value is `ERR_VALIDATION`.
18. A plugin keeps no state the result depends on (`plugins.md` rule 40). A cached login token is a performance cache: a new instance logs in again, a 401 triggers it.

## Namespaces

An id namespace names the system an external id belongs to (`external-ids.md`). The set is open to plugins, in two classes.

| | Core namespace | Plugin namespace |
|---|---|---|
| Form | bare name `^[a-z][a-z0-9]{1,31}$`: `tmdb tvdb imdb` and those `ExternalProvider` lists | `<pluginId>:<name>`, `<name>` = `^[a-z][a-z0-9-]{0,31}$`, e.g. `org.example.anime:aid` |
| Declared by | `ExternalProvider` (Rust); adding one is a core change | the manifest of the plugin whose id is the prefix |
| An id is valid | `ExternalProvider::normalize` | the manifest's `idPattern`, applied by the core |
| Unique | decided by the core (`is_unique`) | never |
| Served by | an `official` package only | the owning plugin |

19. A namespace name is classified by form (`fliks_domain::plugins::provider::classify`): a name with no `:` is core, one with a `:` is a plugin namespace whose prefix is a legal plugin id (`plugins.md` rule 1) and whose rest matches the form above; anything else is no namespace and fails the shape check. `:` appears in no core name, so a plugin namespace cannot imitate a core one, present or future.
20. Registration checks, in declaration order, the first failure ends the registration with that reason (`plugins.md` rule 7, after the permissions and routes of step 8): a plugin namespace whose prefix is not the plugin's own id is `namespace-not-owned`; a bare name `ExternalProvider` does not know is `unknown-provider-namespace`; a bare name it knows declared by a package that is not `official` is `core-namespace-not-official`; an `idPattern` that is not anchored (`^` first, an unescaped `$` last), is over 256 characters (counted in characters, not bytes) or does not compile is `invalid-namespace-pattern`. Patterns use the syntax of the Rust `regex` crate (linear time, no lookaround or backreference, so a pattern cannot be made to backtrack), built with a 1 MiB compiled-size limit and a nesting limit of 32, and applied as `^(?:<idPattern>)$` so a match is always a full match whatever alternation the author wrote. The core compiles it once per namespace (`IdRule`), not per id. Registration runs these checks (`check_namespaces`) for every provider block; `namespace-signer-changed` (rule 21) is not checked until the `provider_namespaces` table exists (PV.10).
21. Ownership is frozen by signer. The table `provider_namespaces(name text PRIMARY KEY, "pluginId" text NOT NULL, "signerKeyId" text NULL, "idPattern" text NOT NULL, "case" text NOT NULL, label text NOT NULL, "createdAt", "updatedAt")` is written at the first activation (the plugin's later activations refresh `idPattern`, `case` and `label`). A package that claims an existing namespace under a different signer, signed when the row is unsigned or the other way round, fails `namespace-signer-changed`, the rule `plugin_kept_data` applies (`plugins.md` rule 20). Core namespaces have no row.
22. The migration is `1789000000300_provider-namespaces.sql` (the block `300`-`309` is this feature's): `provider_namespaces`, and the closed `CHECK`s on `media_external_ids` (030), `requests` (040), `person_external_ids` (100) and `collection_external_ids` (120) become one form check, at most 84 bytes: `provider ~ '^[a-z][a-z0-9]{1,31}$' OR provider ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$'`. The database no longer knows which bare names are the core's: Rust checks it on every write. No data moves.
23. Rust: `fliks_domain::external_id::Namespace` is `Core(ExternalProvider)` or `Plugin(PluginNamespace)`. `ExternalProvider` stays the closed enum where the code reasons on one namespace (uniqueness, collections, the `tmdbId` of the request wire). Registry keys, `metadata_snapshots`, `media_field_sources`, the order per kind and `preferredProvider` use `Namespace`.
24. The pure functions (`classify`, `check_namespaces`, `IdRule::new` and `IdRule::normalize`, `validate_block`) live in `fliks_domain::plugins::provider`; the vector sets `provider-namespace` and `plugin-manifest` pin them.
25. A plugin namespace is never unique, with no admin opt-in: an opt-in needs a partial unique index driven by a flag over data that may already hold duplicates, and a 409 path for a namespace the core knows nothing about. Two media for one title are avoided by the title lock and the lowest-id lookup of rule 31.
26. Cross ids. A record often carries ids of other namespaces (TVDB answers `tmdbId`). The merge keeps, from an `official` provider, what it keeps today; from a third-party provider, its own namespaces and the non-unique core namespaces (`imdb`, `tvdb`, `isbn`, `asin`), and drops the ids of a unique core namespace (`tmdb`, `openlibrary`). A third-party plugin can neither link a media to a `tmdb` id nor cause a 409 on one held by another media; it can help identification by `imdb`.
27. Uninstall or disable of a third-party provider keeps its ids (`media_external_ids`, `person_external_ids`, `requests`) and its `provider_namespaces` row: they are the media's data, like a kept schema (`plugins.md` rule 20). With no provider, the namespace is no longer refreshed and the merge skips it; a field it filled and nobody locked is taken at the next refresh by the next provider in the order. The client shows the raw id with the stored `label`. A reinstall by the same signer resumes everything.
28. Normalisation of a plugin id: trim, NFC, `case` applied (`lower`, `upper`), 1 to 128 characters, no control character, format character (Unicode `Cf`), whitespace (U+2028 included) or `:`, then a full match of `idPattern`. An id it refuses is dropped with a warn naming the namespace, never the value, and does not block the rest of the record. It applies to every id that enters: the `ids` of records, the `find-by` result, the ids of the link routes (`media/external_ids.rs`) and of `media-resolve-or-create`. An `idPattern` changed by an update governs later writes; stored ids are not revalidated (a warn counts those that no longer match).
29. `DELETE /api/plugins/:id?deleteData=true` also deletes, in one transaction, the ids of the plugin's namespaces in the four tables, its `metadata_snapshots`, its `media_field_sources` rows and its `provider_namespaces` rows. A request that is not finished and holds only by such an id becomes `failed` with reason `provider-removed`; a finished request keeps its row without the id.
30. Title lock: `requests:<kind>:<namespace>:<id>` holds as it is for a plugin namespace (the `:` of the namespace is not ambiguous: kind and id carry none, and rule 28 refuses an id with one).
31. `media-resolve-or-create` (`plugins.md` rule 57) takes the first entry of a unique core namespace served by an available provider (`tmdb` for video, `openlibrary` for books); failing that, the first entry of any other namespace served by an available provider that declares `work` for the kind. Under the lock of that entry it answers the lowest media id holding it (`external-ids.md` rule 6), else imports. Two plugins naming one title by two namespaces create two media; manual merge is the remedy. `unsupported-provider` when no entry has an available provider.
32. Images. The URL of an image comes from the plugin and is untrusted. `images/store.rs` downloads through the outbound connector (`net::guard`, the address classes of `fliks_domain::net`), only from a host of `provider.imageHosts` of the provider that supplied the record (provenance by `media_field_sources`), and follows redirects only to a host of the same list.
33. Without TMDB (disabled, or a build with no default key and no override): `movie` and `series` go through TVDB or a third-party provider; with no video provider a scan creates unidentified titles and the search routes answer `[]`; `media-resolve-or-create` falls to the next entry (rule 31).

## Defaults and overrides

34. Fliks keeps default values compiled into the server binary, not read from the environment: `plugins/defaults.rs` holds `DEFAULTS: &[(ExternalProvider, &str, Option<&str>)]` (`tmdb` and `tvdb`, key `apiKey`, from `option_env!("FLIKS_DEFAULT_TMDB_API_KEY")` and `FLIKS_DEFAULT_TVDB_API_KEY`), empty in a local build. No route serves a default.
35. A form field of the plugin declares its default: `{"key": "apiKey", "type": "text", "labelKey": "tmdb.apiKey", "secret": true, "default": "fliks:apiKey"}`. The host resolves `plugin.<id>.apiKey` as the stored override when non-empty, else the Fliks default, in the `hello` config and in `config-get` (`plugins.md` rules 34, 41). `config-changed` is sent when the override changes or is cleared. The plugin cannot tell where a value comes from.
36. `fliks:<key>` resolves only for a plugin whose first namespace is the namespace of the `DEFAULTS` entry and whose package is `official` (`verifiedByKeyId` is a compiled key). Otherwise the field has no default (a warn at registration; the plugin works with a key the admin types). No plugin reads another namespace's key.
37. The override is the setting `plugin.<id>.apiKey` (secret through the field's `secret: true`, `settings.md` rule 17); no new table. `PUT /api/settings/plugin.<id>.apiKey` with `value: null` clears it (`settings.md` rule 16): the effective value is the default again. Writing or clearing needs `Manage Settings`.
38. Nobody reads a key back. `GET /api/settings` returns only `secretsSet`; a default appears in no response, no export (`GET /api/plugins/:id/export` knows only stored settings) and no log (the outbound guard never logs a URL).
39. `GET /plugins/ui` gives each field `hasDefault: bool` (rule 36) and `requiredByProvider: bool` (the key is in `requires`), and drops a `fliks:` `default`. For a secret field the client shows "Fliks default key" when `hasDefault` and not in `secretsSet`; "Custom key" and a **Reset** button when both; "Key required" when neither and `requiredByProvider`; typing an unsaved key hides "Fliks default key".
40. Environment keys: `TMDB_API_KEY` and `TVDB_API_KEY` are imported once into `plugin.fliks.tmdb.apiKey` and `plugin.fliks.tvdb.apiKey` when they differ from the compiled default, the setting `metadata.env_keys_imported = 'true'` marking it done; later boots ignore them with a warn. `FLIKS_TMDB_API_URL`, `FLIKS_TVDB_API_URL` and `FLIKS_TMDB_IMAGE_URL` are removed; tests redirect upstreams with `FLIKS_PLUGIN_UPSTREAM_OVERRIDE=<host>=<url>,...`, read at boot, logged at warn, applied by the outbound hook (host rewrite, the target exempt from the private class).

## Availability and choice

41. A provider is available when it is registered, `ready`, and every key of `requires` resolves non-empty (override or default). Providers enter the registry (`Metadata`, a `RwLock<HashMap<Namespace, Arc<dyn MetadataProvider>>>`) when they become `ready` and leave it when they fail, are disabled or uninstalled.
42. Order per kind: the setting `metadata.provider_order.<kind>` (a JSON array of namespaces). Default: `movie` and `series` to `[tmdb, tvdb]`; `book` to `[openlibrary, bnf, googlebooks, audible, audnexus]`. An installed third-party provider is appended for its kinds; the admin moves it up. An absent or unavailable namespace is skipped.
43. `libraries."preferredProvider"` keeps its values and accepts a plugin namespace; it goes first. `resolve(name)` is the named provider if available, else the first available of the kind's order, else none (no provider: rule 33). `fallback` and `person_fallback` are the next in the order. Per-field orders of books stay core constants indexed by namespace; a plugin namespace takes the place of its rank in the kind's order for each field, and the merge ignores a namespace with no provider.
44. The list routes (trending, popular, upcoming, genres, discover) call `list` on the provider that declares `lists` for the kind; the stale-while-error cache of `metadata.md` rule 17 moves to `metadata/service.rs`, keyed `(namespace, name, kind, params, locale)`. With no provider for `lists` the answer is an empty list or page.

## Bundled providers

45. The official providers are bundled: their signed archives are embedded in the server binary and installed at boot, so Fliks works offline on its first boot. At boot, before the plugins register, each embedded archive goes through the normal install pipeline (inspect, signature, promote) with `origin = 'bundled'` when no package of the id exists or the embedded version is newer than the installed one. A newer version installed from the catalog stays: no downgrade.
46. The daily auto-update (`plugins.md` rule 29) updates them between Fliks releases, with its gates. `plugins.auto_update = 'false'` does not stop a Fliks release from bringing its embedded version.
47. A bundled provider is disabled, not uninstalled: `DELETE` answers 409 `PLUGIN_BUNDLED` (the next boot would reinstall it). `FLIKS_PLUGINS_DISABLED=1` stops every plugin except the bundled ones (`plugins.md` rule 23): without providers Fliks has no metadata.
48. A bundled provider put `failed` by the plugin breaker (`plugins.md` rule 42) registers again by itself after 10 minutes (one try, then every 30 minutes). Meanwhile the core treats it as unavailable and `fallback` takes the next. A third-party provider keeps rule 42 as it is.
49. A metadata call that arrives while its provider is `starting` waits for `ready` at most 30 s, then fails "provider starting".

## Lane and outbound limits

50. A plugin with a `provider` block has a lane `provider` next to `core`: 0 to 8 shared instances, a queue of 64 calls.
51. Queue wait at most 5 s for an interactive call and 60 s for a background one. Export deadline: 20 s interactive and 120 s background for `search`, `fetch-work`, `fetch-edition`, `fetch-person`, `person-credits`, `find-by`, `list`, `fetch-chapters`; 120 s and 600 s for `fetch-children`.
52. A `fetch-children` of a series issues its season requests in parallel inside one export (the SDK's `rt` waits on several responses with `wasi:io/poll`), bounded by the limiter and the 32 in-flight requests per plugin.
53. Memory per instance is the manifest's `memoryMb`; an instance idle for 10 minutes is removed (`plugins.md` rule 40).
54. The limiter stays in the host. The semantics of `Guarded::send` (breaker, token, `Retry-After` pause, backoff, quota, retries, interactive budget, slow-call log) are those of the outbound hook for a plugin with a `provider` block, using `fliks_domain::metadata::limiter` and `breaker` as they are, one pair per plugin built from `provider.limits`: every outbound request of an export takes a token at the export's priority; on 429 or 503 the host reads `Retry-After`, pauses the limiter and replays the request itself (body kept in memory up to 64 KiB, so GETs and small POSTs such as the TVDB login) with the current counters (1 retry interactive, 3 background); the guest sees only the final response; one that reads a quota error in an upstream's body answers `rate-limited(retry)` and the host pauses the limiter for `retry` seconds. `requestTimeoutMs` bounds each request within the export's deadline.
55. A plugin, a third-party one included, cannot bypass politeness toward the upstream: there is one tested implementation instead of one per plugin, and the priority never leaves the host.
56. The hook decides on each answer. A 2xx resets the backoff; a 429 or 503 pauses the limiter (`Retry-After` as delta-seconds or an HTTP date, else the backoff step) and is replayed within rule 54's counts when the request body was sent whole and is at most 64 KiB, an interactive replay only if the pause fits the 5 s budget; any other status resets the backoff. The breaker (3 consecutive failures, open 30 s) sees one outcome per export request: the final status, or a transport failure. A replay that cannot go (no token within the budget, spent quota) leaves the guest the last 429 or 503 it received.
57. The host answers in place of the upstream, with no request made: `429` with `Retry-After` in seconds when the daily quota is spent or an interactive request would wait past 5 s for a token or a pause, `503` while the breaker is open. The body is `{"message": "<plugin id> <reason>"}`. A request whose retry hint the plugin read in the body returns `rate-limited(retry)`; the host then pauses the limiter for `retry` seconds (at most 5 minutes).
58. The priority of an export is held in the Store the call runs in and applied to each of its requests; a request outside an export (`hello`, `health`) is background. `requestTimeoutMs` (default 10000) bounds the connection and the response headers of each attempt; the body is bounded by the between-bytes timeout.
59. `FLIKS_PLUGIN_UPSTREAM_OVERRIDE` is compiled only with the `parity` cargo feature (rule 40, `config.md`). The hook rewrites the scheme, host and port of a request whose host is listed to the target's, prefixing the target's path, and vets the target as an internal address; the `Host` header is the guest's.

## Vectors/parity

Vector sets: `plugin-manifest` (the `provider` block: accept and refuse per key, the empty `scopes` and `database.schema` rules) and `provider-namespace` (`classify`, ownership and registration reasons of rule 20, `IdRule::normalize` of rule 28), replayed by `crates/server/src/plugins/vectors.rs` and `crates/domain/tests/plugin_vectors.rs`. The component fixture `crates/plugin-sdk/examples/fixture-provider` is packaged and world-checked by `cargo xtask build examples/fixture-provider` and its test; `crates/server/tests/it/plugins/provider.rs` registers it against rules 1, 2 and 20.
