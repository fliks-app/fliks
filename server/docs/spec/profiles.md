# Spec: profiles (quality profiles, language profiles, custom formats, quality definitions)

Auth, CASL and error-body rules are in `auth.md` ("auth rule N"); validation body = auth rule 16; non-integer path param 400 = auth rule 18; 4xx/5xx `Cache-Control: no-store` = `bootstrap.md` rule 7. The pure logic (release parsing, custom-format matching, scoring) is in `release.md` ("release rule N"); the NamingService is `naming.md`.

Quality is kept per family (`fliks_domain::media::family::Family`: `video`, `audio`, `text`, `image`): `quality_profiles.family` and `quality_definitions.family` are `text` under `CHECK (family IN ('video'))`, default `'video'`, widened with each family's quality table. A profile's `items` and `cutoff` are ids of its family's table (`fliks_domain::profiles::table(family)`, `APP_QUALITIES` for `video`, empty for the others). `family` is not serialised: every payload below is the video one. Custom formats and language profiles are family-neutral.

Routes are CRUD over four small tables. Everything pure that these routes or other callers need live in `fliks_domain` (`release.md`); this spec owns the HTTP contract, the DB access and the helper functions other services call (rules 31-35).

## Routes

20 routes (11 + 6 + 3). Class-level guards `JwtOrApiKeyGuard, PoliciesGuard` on all three controllers. 401 on missing or invalid credentials (auth rule 14); a `scope:'stream'` token is rejected (401) and no route here is stream-allowed. POST = 201 (also `custom-formats/test` and `quality-definitions/reset`), PUT = 200, DELETE = 200 with an empty body. 403 body = auth rule 27. `QP` = quality profile JSON (rule 6), `LP` = language profile JSON (rule 14), `CF` = custom format JSON (rule 18), `QD` = quality definition JSON (rule 24).

| Method path | Auth (extractor + policy) | Request (fields, constraints) | Response (fields, types, nesting) | Errors (status, message/code) | Side effects |
|---|---|---|---|---|---|
| `GET /api/profiles/quality` | class guards; `ability.can(Action.Read, QualityProfile)` (`media.read`, `settings.access`, `manage:all`) | none | 200, `QP[]` `ORDER BY name ASC, id ASC` | 401, 403 | none |
| `POST /api/profiles/quality` | `ability.can(Action.Create, QualityProfile)` (`settings.access`, `manage:all`) | body `CreateQualityProfileDto` (rule 7) | 201, `QP` | 400 validation (incl. rule 36); 403 | INSERT `quality_profiles` |
| `GET /api/profiles/quality/:id` | `Action.Read, QualityProfile` | path `id` int | 200, `QP` | 400 `Validation failed (numeric string is expected)`; 404 `QualityProfile #<id> not found`; 403 | none |
| `PUT /api/profiles/quality/:id` | `Action.Update, QualityProfile` (`settings.access`, `manage:all`) | path `id`; body `CreateQualityProfileDto` (same DTO as create, all required fields) | 200, `QP` | 400; 403; 404 as above | UPDATE `quality_profiles` |
| `DELETE /api/profiles/quality/:id` | `Action.Delete, QualityProfile` (`settings.access`, `manage:all`) | path `id` | 200, no body | 400; 403; 404 | DELETE; FKs set `NULL` (rule 11) |
| `GET /api/profiles/language-definitions` | `Action.Read, LanguageProfile` | none | 200, `AppLanguage[]` = the static `APP_LANGUAGES` table (rule 16) | 403 | none |
| `GET /api/profiles/language` | `Action.Read, LanguageProfile` | none | 200, `LP[]` `ORDER BY name ASC, id ASC` | 403 | none |
| `POST /api/profiles/language` | `Action.Create, LanguageProfile` | body `CreateLanguageProfileDto` (rule 15) | 201, `LP` | 400; 403 | INSERT `language_profiles` |
| `GET /api/profiles/language/:id` | `Action.Read, LanguageProfile` | path `id` | 200, `LP` | 400; 404 `LanguageProfile #<id> not found`; 403 | none |
| `PUT /api/profiles/language/:id` | `Action.Update, LanguageProfile` | path `id`; body `CreateLanguageProfileDto` | 200, `LP` | 400; 403; 404 | UPDATE `language_profiles` |
| `DELETE /api/profiles/language/:id` | `Action.Delete, LanguageProfile` | path `id` | 200, no body | 400; 403; 404 | DELETE; FKs set `NULL` |
| `GET /api/custom-formats` | `Action.Read, 'Settings'` (`settings.access`, `manage:all`) | none | 200, `CF[]` `ORDER BY name ASC, id ASC` | 403 | none |
| `POST /api/custom-formats` | `Action.Manage, 'Settings'` | body `CreateCustomFormatDto` (rule 19) | 201, `CF` | 400 validation; 400 `Invalid regular expression: <value>` (rule 21); 403 | INSERT `custom_formats` |
| `POST /api/custom-formats/test` | `Action.Read, 'Settings'` | body `TestCustomFormatDto` (rule 22) | 201, `CustomFormatMatch[]` (rule 22) | 400; 403 | none |
| `GET /api/custom-formats/:id` | `Action.Read, 'Settings'` | path `id` | 200, `CF` | 400; 404 `Custom format #<id> not found`; 403 | none |
| `PUT /api/custom-formats/:id` | `Action.Manage, 'Settings'` | path `id`; body `CreateCustomFormatDto` | 200, `CF` | 400 (incl. regex); 403; 404 | UPDATE `custom_formats` |
| `DELETE /api/custom-formats/:id` | `Action.Manage, 'Settings'` | path `id` | 200, no body | 400; 403; 404 | DELETE `custom_formats` |
| `GET /api/quality-definitions` | `Action.Read, 'Settings'` | none | 200, `QD[]` `ORDER BY "qualityId" ASC` | 403 | seeds when the table is empty (rule 25) |
| `POST /api/quality-definitions/reset` | `Action.Update, 'Settings'` (`settings.access`, `manage:all`) | none (the client posts `{}`; a body is ignored) | 201, `QD[]`: the stored rows with the default sizes applied, NOT saved (rule 28) | 403 | seeds when the table is empty (rule 25) |
| `PUT /api/quality-definitions` | `Action.Update, 'Settings'` | body `{items: QualityDefinitionItemDto[]}` (rule 29) | 200, `QD[]` re-read | 400; 403 | UPDATE per item |

Declaration order: `custom-formats/test` is a POST and `:id` routes have no POST, so no shadowing; axum needs no ordering. No route emits an SSE or domain event.

## Rules

### A. Common

1. Policies, from the CASL factory: `Read QualityProfile` / `Read LanguageProfile` are granted by `media.read`; `Manage` of both (every action: create, update, delete included) by `settings.access`; `manage:all` everything. The custom-format and quality-definition routes use the string subject `'Settings'`, granted only by `settings.access` (`Read` and `Manage` both; `Action.Update` is covered by `Manage`) or `manage:all`. So the default `User` and `Readonly` roles (`media.read`) read quality/language profiles and language definitions, and cannot read custom formats or quality definitions.
2. Validation is the global pipe (auth rule 16): body whitelisted, unknown keys 400 `property <k> should not exist`, including inside nested items (`items.0.x`, `specs.0.x`, `audioLanguages.0.x`); JSON types are strict (a number field accepts non-integers and rejects strings; a boolean field rejects `"true"`; an optional field accepts `null`). Every DTO and nested item is `#[serde(deny_unknown_fields)]`.
3. `:id` params are canonical integers only (auth rule 18): ` 7 `/`1e1`/`0x10` are 400, and an id outside the `int4` range is 400 `Validation failed (numeric string is expected)`.
4. Timestamps `createdAt`/`updatedAt` serialise as ISO-8601 with milliseconds (`timestamptz`); `updatedAt` is maintained by the `set_updated_at` trigger (migration `1786500000000_updated_at_trigger.sql`), so the UPDATE is issued every time and a PUT that changes nothing still bumps it; parity ignores `$..updatedAt`.
5. Lists end with `id ASC` as final tie-break: `ORDER BY name ASC, id ASC` in SQL. The sort runs in Postgres (unlike `libraries.md` rule 3, nothing is sorted in application code). Quality definitions order by `"qualityId"`, unique per family.
6. Write routes answer `INSERT/UPDATE... RETURNING *` (one statement): every column is set explicitly on create, so the body equals a re-read (`id`, `createdAt`, `updatedAt` from the INSERT). `QP` JSON = `{id: number, createdAt, updatedAt, name: string, cutoff: number, items: QPItem[], upgradeAllowed: boolean, resolutionUpgradeOnly: boolean, minCustomFormatScore: number}`; `QPItem` = `{quality: {id: number, name: string, resolution: number, source: string}, allowed: boolean, sortOrder: number, groupId?: number}` (`groupId` key absent when none).

### B. Quality profiles

7. `CreateQualityProfileDto`: `name` string (required, empty allowed); `cutoff` number (required); `upgradeAllowed?`, `resolutionUpgradeOnly?` boolean; `minCustomFormatScore?` number; `items` array (required, may be empty) of `QualityItemDto` = `qualityId` number, `qualityName` string, `resolution` number, `source` string, `allowed` boolean, `sortOrder` number (all required), `groupId?` number. `null` is accepted on every optional field.
8. Create: row = `name`, `cutoff`, `upgradeAllowed ?? false`, `resolutionUpgradeOnly ?? false`, `minCustomFormatScore ?? 0` (so `null` stores the default), `items` mapped 1:1: DTO `{qualityId, qualityName, resolution, source}` becomes `quality: {id, name, resolution, source}`, `allowed`, `sortOrder`, `groupId: groupId ?? undefined` (null and absent both drop the key). Stored as jsonb; numbers keep whatever the client sent (a non-integer `sortOrder` is stored as is).
9. Update (PUT, full replace): load or 404; `name`, `cutoff` replaced; the three optionals KEEP the stored value when absent or `null` (`dto.x ?? profile.x`: differs from create's reset to defaults); `items` replaced wholesale with the rule 8 mapping.
10. Get one: `QualityProfile #<id> not found` 404 (`{message, error:"Not Found", statusCode:404}`).
11. Delete: 404 when missing, else `DELETE`; no usage check. The FKs `libraries.defaultQualityProfileId`, `wants.qualityProfileId` (`items.md` rule 30), `requests.qualityProfileId` are `ON DELETE SET NULL`, so a profile in use disappears silently and its titles become unprofiled (rule 40). Delete is `DELETE... WHERE id = $1 RETURNING id`, no row = 404.
12. No validation exists for these: `cutoff` need not be the id of an item; item `quality` ids need not exist in `APP_QUALITIES`; names are not unique; `groupId` semantics are the scorer's (`release.md` rule 27). A cutoff that matches no item resolves to resolution 0 in `cutoffResolution` (rule 34; rule 40).
13. `items` order is the client's; the server never sorts or re-numbers it.

### C. Language profiles

14. `LP` JSON = `{id, createdAt, updatedAt, name: string, audioLanguages: {isoCode: string, name: string}[], subtitleLanguages: SubItem[]}`; `SubItem` = `{isoCode: string, name: string, forced: boolean, hi: boolean, hearingImpaired?: 'prefer'|'avoid'|'require'|'forbid'}`. Items are stored verbatim after validation: an absent `hearingImpaired` stays absent, an explicit `null` stays `null` (optional fields accept `null`) in the stored jsonb and in every response.
15. `CreateLanguageProfileDto`: `name` string (required); `audioLanguages?` array of `{isoCode: string, name: string}`; `subtitleLanguages?` array of `{isoCode: string, name: string, forced: boolean (required), hi: boolean (required), hearingImpaired?: one of the four modes}`. `isoCode` is NOT checked against `APP_LANGUAGES`. Create stores `audioLanguages ?? []`, `subtitleLanguages ?? []`. PUT is a full replace and an absent (or `null`) array RESETS to `[]` (unlike the quality profile's keep, rule 9).
16. `GET /profiles/language-definitions` returns `APP_LANGUAGES` unchanged: 38 rows `{id, name, isoCode, iso639_2?}` (ids 1..37 then 99 `Unknown`/`xx`, the only row without `iso639_2`: key absent). It is a constant in `fliks_domain::language::APP_LANGUAGES` (`release.md` rule 4; fixture set `app-languages`).
17. Get one / delete / list: as rules 5, 10, 11 with the message `LanguageProfile #<id> not found`; FKs `libraries.defaultLanguageProfileId`, `media.languageProfileId`, `requests.languageProfileId` are `ON DELETE SET NULL`.

### D. Custom formats

18. `CF` JSON = `{id, createdAt, updatedAt, name: string, score: number (int), specs: Spec[]}`; `Spec` = `{type: 'title_regex'|'source'|'resolution'|'language'|'release_flag'|'release_group'|'edition'|'video_codec'|'audio_codec', value: string, negate?: boolean, required?: boolean}` stored verbatim (absent stays absent, `null` stays `null`). The column is `specs` (renamed from `specifications` by migration `1784600000000`).
19. `CreateCustomFormatDto`: `name` string non-empty; `score?` number; `specs` array NON-empty (a format with no condition would match every release) of `{type: one of the nine, value: non-empty string, negate?: boolean, required?: boolean}`.
20. Create stores `score ?? 0`. Update loads (404 `Custom format #<id> not found`), runs rule 21, then replaces `name`, `score = dto.score ?? 0` (an absent score RESETS to 0 on PUT, rule 40) and `specs`.
21. Regex check at write, for `type = 'title_regex'` only, in spec order: the value must compile as a JS `RegExp(value, 'i')`, else 400 `Invalid regular expression: <value>` (string `message`, `error: "Bad Request"`) for the FIRST bad spec, before any write (create) or after the 404 check (update). The regex engine and the handling of stored patterns it rejects: rule 39.
22. `POST /custom-formats/test`: `TestCustomFormatDto` = `title` string non-empty (required), `freeleech?` boolean, `downloadVolumeFactor?` number (no `flags` field: the open flag set is not reachable here). Flags = `releaseFlags(dto)` (`release.md` rule 24). Response = one entry per stored format in list order (rule 5): `{formatId: number, formatName: string, matched: boolean, score: number}` with `score = matched ? format.score: 0`. Matching = `fliks_domain::release::scoring::custom_format::matches_format` (`release.md` rules 46-47). Read-only.
23. `score_release_with(formats, title, flags)` (sum of the scores of the matching formats over a list the caller already read) lives with the matcher in `release.md`, not as an HTTP concern.

### E. Quality definitions

24. `QD` JSON = `{id, createdAt, updatedAt, qualityId: number (unique per family), title: string, minSize: number, preferredSize: number, maxSize: number}`; sizes are `double precision` in MB per hour of content, `0` on min/max = no limit.
25. Seeding: when `SELECT count(*) FROM quality_definitions` is 0, insert one row per quality of the family (`video`: the 24 `APP_QUALITIES` entries, `title` = quality name, sizes from rule 26; the count and the insert are per family, `family = 'video'`). `profiles::seed_quality_definitions(pool)` runs at boot after migrations and before the server listens (like `roles::seed`, `roles.md` rule 11), and again at the start of `GET` / `POST /reset` / `PUT` (idempotent: `INSERT... ON CONFLICT (family, "qualityId") DO NOTHING` guarded by the empty check of the family, so concurrent first calls do not fail).
26. Default sizes (`min`/`preferred`/`max`, MB/h) by key `"<resolution>-<source>"` then `"<resolution>"` then `"0"`: `0`: 0/700/1500; `480`: 0/800/1500; `720-hdtv` 150/1200/2500; `720-web` 150/1500/3000; `720-bluray` 250/2500/5000; `720` 150/1500/3500; `1080-hdtv` 250/2000/4000; `1080-web` 250/3000/5000; `1080-bluray` 400/5000/10000; `1080-remux` 8000/18000/30000; `1080` 250/3000/6000; `2160-hdtv` 600/4000/8000; `2160-web` 600/6000/12000; `2160-bluray` 1000/12000/25000; `2160-remux` 15000/35000/60000; `2160` 600/8000/20000. Consequences pinned by the vector `quality-definition-defaults`: resolution-0 qualities (ids 1-4) and an unknown id get `0`; `480p` qualities (ids 5-10, incl. DVD and Bluray-480p) all get `480`; `720p` sources `web`/`hdtv`/`bluray` hit their own key.
27. `GET`: seed check then `SELECT * FROM quality_definitions WHERE family = 'video' ORDER BY "qualityId" ASC`.
28. `POST /reset` writes nothing beyond the rule 25 seed (it reads through `findAll`): it returns the stored rows (same order, `id`, `qualityId`, `title`, dates untouched) with `minSize`/`preferredSize`/`maxSize` replaced by the rule 26 defaults of the row's quality (`APP_QUALITIES` entry matched by `qualityId`; a `qualityId` not in the table gets the `"0"` defaults). The client fills its form with the answer and the user saves with `PUT`.
29. `PUT`: `UpdateQualityDefinitionsDto` = `{items: QualityDefinitionItemDto[]}` (`items` required, may be empty; item = `qualityId` number, `title?` string, `minSize`/`preferredSize`/`maxSize` number `>= 0`, all required but title). Seed check, then per item in order `UPDATE quality_definitions SET title = COALESCE($title, title), "minSize", "preferredSize", "maxSize" WHERE family = 'video' AND "qualityId" = $1` (`title` is unchanged when absent), then answer `findAll()`. An unknown `qualityId` updates nothing and is not an error (rule 40); a repeated `qualityId` applies in order (last wins); `qualityId` is never changed or created by this route. The whole loop runs in ONE transaction, after the whole request is validated and authorised.
30. The scorer takes the map `qualityId -> {min, preferred, max}` built from the stored quality definitions (`release.md` rules 29, 42).

### F. Helpers other services call (service functions in `crates/server/src/profiles/`)

31. `resolve_quality_profile_id_for_import(requested: Option<i32>, library_default: Option<i32>) -> Result<Option<i32>>`: `requested` set (not null/undefined): that profile must exist, else 400 `Quality profile #<id> not found`, and it wins; else `library_default` when set AND the profile still exists; else the lowest-id profile; else `None`. Language twin `resolve_language_profile_id_for_import`, message `Language profile #<id> not found`. Caller: media import (five test cases in `crates/server/tests/it/profiles.rs`).
32. `find_quality_profile(id)` / `find_language_profile(id)` (404 messages of rules 10, 17): used by the media `PATCH /api/media/:id/profiles` handler to check a profile exists before assigning it (`media-write.md`).
33. `quality_profile_covers(existing, requested)`: `existing` null: false; same id: true; either profile missing: false; else `cutoffResolution(existing) >= cutoffResolution(requested)`. `language_profile_covers`: null: false; same id: true; either missing: false; else every audio `isoCode` of the requested profile is among the existing profile's audio `isoCode`s (subtitles are not compared; an empty requested list is covered). `envelope_covers(existing, requested)`: each axis is checked only when the requested side is non-null, both must hold. Callers: requests and lifecycle only (`requests.md` rule 36).
34. `cutoffResolution(profile)` = `resolution` of the item whose `quality.id === profile.cutoff`, else 0.
35. The allowed quality ids and allowed audio language ids of a media's profiles are computed by the pure `build_allowed_quality_ids` / `allowed_audio_language_ids` in `release.md` (rules 26-27); there is no service wrapper.

### G. Input limits, regex engine, defaults

36. No 500 on input the DTOs let through. `cutoff`, `minCustomFormatScore`, `score` (custom format) must be integers within `int4`; `qualityId` of a definition item within `int4` and integral (the size fields are finite numbers `>= 0`); non-integer or out-of-range values, `title: null` on a definition item, and an out-of-range `:id` answer 400 with the standard validation body.
37. `title_regex` has no evaluation budget (only an admin can write a pattern): see rule 39.
38. `PUT /quality-definitions` is one transaction (rule 29), validated and authorised as a whole before the first write; the other writes are single statements.
39. `title_regex` compiles with `regress` (`icase`), so every stored pattern keeps the meaning of a JS `RegExp(v, 'i')` (lookbehind, backreferences, named groups, ES case folding); a pattern it rejects is 400 at write and logged at boot when already stored. The internal fixed patterns stay on `regex` / `fancy-regex` (the vectors prove each). `regress` has no backtracking budget, so evaluation has no step budget (`release.md` rule 50).
40. `POST /api/quality-definitions/reset` only computes defaults (the client then saves with PUT); `cutoff` is not required to be among the items, duplicate names are allowed, an absent `score` on custom-format PUT resets to 0 while an absent optional on quality-profile PUT keeps the stored value, an absent language-profile array resets; deleting a profile that libraries, media or requests reference silently nulls them (titles become `unprofiled`); a definition `qualityId` that does not exist is ignored by PUT. An integral `f64` sent as `1.0` is serialised as `1.0`: clients parse `1` and `1.0` alike and parity compares numerically.
41. Profile code lives only in `crates/server/src/profiles/`.

## SQL

Tables `quality_profiles`, `language_profiles`, `custom_formats`, `quality_definitions` (DDL: baseline `1777816212948_baseline.sql` plus `1780500000000` `resolutionUpgradeOnly`, `1784600000000` `minCustomFormatScore` and `specifications` -> `specs` (rewrites stored specs with explicit `negate`/`required: false`, deletes formats left with no spec), `1785000000000` default `minSize` on rows still at 0, `1778300000000` inserts the default language profile `Toutes les langues (défaut)` when none exists, `1783000000000` timestamptz, `1786500000000` trigger). `jsonb` columns are bound as `jsonb` parameters.

- Quality profile list: `SELECT * FROM quality_profiles ORDER BY name ASC, id ASC`. One: `SELECT * FROM quality_profiles WHERE id = $1`.
- Quality profile create: `INSERT INTO quality_profiles (name, cutoff, items, "upgradeAllowed", "resolutionUpgradeOnly", "minCustomFormatScore") VALUES ($1,$2,$3,COALESCE($4,false),COALESCE($5,false),COALESCE($6,0)) RETURNING *`.
- Quality profile update: `UPDATE quality_profiles SET name = $2, cutoff = $3, items = $4, "upgradeAllowed" = COALESCE($5,"upgradeAllowed"), "resolutionUpgradeOnly" = COALESCE($6,"resolutionUpgradeOnly"), "minCustomFormatScore" = COALESCE($7,"minCustomFormatScore") WHERE id = $1 RETURNING *` (no row = 404).
- Delete: `DELETE FROM quality_profiles WHERE id = $1 RETURNING id`; same for `language_profiles`, `custom_formats`.
- Language profile list / one: as above on `language_profiles`. Create: `INSERT INTO language_profiles (name, "audioLanguages", "subtitleLanguages") VALUES ($1, COALESCE($2,'[]'), COALESCE($3,'[]')) RETURNING *`. Update: `UPDATE language_profiles SET name = $2, "audioLanguages" = COALESCE($3,'[]'), "subtitleLanguages" = COALESCE($4,'[]') WHERE id = $1 RETURNING *`.
- Custom format list / one on `custom_formats`; create: `INSERT INTO custom_formats (name, score, specs) VALUES ($1, COALESCE($2,0), $3) RETURNING *`; update: `UPDATE custom_formats SET name = $2, score = COALESCE($3,0), specs = $4 WHERE id = $1 RETURNING *`.
- Quality definitions: `SELECT count(*) FROM quality_definitions WHERE family = 'video'`; seed: `INSERT INTO quality_definitions ("qualityId", title, "minSize", "preferredSize", "maxSize") VALUES... ON CONFLICT (family, "qualityId") DO NOTHING`; list: `SELECT * FROM quality_definitions WHERE family = 'video' ORDER BY "qualityId" ASC`; per item: `UPDATE quality_definitions SET title = COALESCE($2,title), "minSize" = $3, "preferredSize" = $4, "maxSize" = $5 WHERE family = 'video' AND "qualityId" = $1`.
- Helpers: resolve: `SELECT id FROM quality_profiles WHERE id = $1`; `SELECT id FROM quality_profiles ORDER BY id ASC LIMIT 1` (language twin on `language_profiles`); covers: two `SELECT *... WHERE id = $1`.

## Events

none emitted or consumed. Profile edits take effect on the next read; no SSE.

## Settings keys

none.

## Jobs/timers

Boot only: `seed_quality_definitions` (rule 25), after migrations and before the server listens.

## Vectors/parity

Fixture sets (`server/fixtures/<set>/cases.json`, replayed in `crates/domain/tests/`; `release.md` Vectors lists the pure sets). Sets used here: `custom-formats` (rules 22-23, `release.md` Vectors) and `app-languages` (rule 16; `release.md` Vectors). The rule 26 default sizes and the seed rows from `APP_QUALITIES` are covered by Rust tests in `crates/domain/src/profiles.rs` (`fliks_domain::profiles::default_sizes(quality_id) -> {min, preferred, max}`).

Rust tests (`#[sqlx::test]`, `crates/server/tests/it/profiles.rs`): CRUD round trip per table with the verbatim-jsonb cases (absent vs `null` `groupId`/`hearingImpaired`/`negate`), update keep-vs-reset (rules 9, 15, 20), the delete FK `SET NULL` on libraries/media/requests, the five resolve cases (rule 31) and the cover cases (rule 33: same id, null, missing, `cutoff` not in items, empty requested audio list), seeding idempotent under two concurrent calls (rule 25), `PUT /quality-definitions` rolls back when one item fails, CASL table (rule 1) against the `acl` set (`media.read`-only reads profiles, not custom formats).

Parity scenarios (`server/parity/scenarios/profiles/`; seed gains 2 quality profiles (one with `groupId` items), 2 language profiles (one with explicit `hearingImpaired`, one subtitle item with `null`), 4 custom formats (a `title_regex`, a `negate`, a `required`, and one stored invalid `title_regex` with `negate`, for the `custom-formats-test` pin), and the 24 definitions seeded lazily by the first `GET`; `ignore: ["$..updatedAt"]`; the non-admin write path uses the seed actor `settings` (`settings.access` only), added by `seed/profiles.sql`):
- Quality: `profiles-quality-list` (admin, `user` read allowed, anon 401), `profiles-quality-create` (full DTO; minimal DTO checks defaults), `profiles-quality-create-validation-400` (missing `items`, unknown key, nested unknown key, string `cutoff`), `profiles-quality-get`, `-get-404`, `-get-badid-400`, `profiles-quality-update` (optionals kept when omitted, `groupId: null` dropped), `profiles-quality-update-404`, `profiles-quality-delete`, `profiles-quality-delete-in-use` (library/media/request ids become `null`), `profiles-quality-write-forbidden` (`user` 403 on POST/PUT/DELETE), `profiles-quality-noncanonical-id` (` 7 `, 400), `profiles-quality-cutoff-float-400` (400).
- Language: `profiles-language-list`, `-create`, `-update-resets-arrays`, `-get-404`, `-delete`, `-validation-400` (bad `hearingImpaired`, missing `forced`), `profiles-language-definitions` (38 rows; `iso639_2` absent on `xx`), `profiles-language-write-forbidden`.
- Custom formats: `custom-formats-list-admin`, `-list-user-403` (`media.read` only), `-create`, `-create-empty-specs-400`, `-create-bad-type-400`, `-create-bad-regex-400` (`Invalid regular expression: (`), `-update` (absent `score` resets to 0), `-get-404`, `-delete`, `custom-formats-test` (title with source/language/resolution; `freeleech: true` matches a `release_flag` format; `downloadVolumeFactor: 0.5` is `halfleech`; an invalid stored regex with `negate` answers `matched: true`, pinned), `custom-formats-test-validation-400`.
- Quality definitions: `quality-definitions-list` (24 rows ascending), `-list-user-403`, `-reset-defaults` (no DB change: a following GET equals the one before), `-update` (sizes changed, unknown `qualityId` ignored, `title` omitted keeps the title), `-update-validation-400` (negative size), `-update-title-null-400` (400).

## Open questions

None.
