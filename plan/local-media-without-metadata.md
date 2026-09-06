# Plan: show every file on disk, matched to a metadata provider or not

Status: **planned, not started**. Written 2026-09-06.

Goal: a video file under a library root is always reachable in Fliks. A title
that TMDB/TVDB never matched (or that the admin never bothered to match) gets a
`Media` row anyway, with a placeholder poster and whatever the file itself can
tell us (filename, `.nfo`, ffprobe, sibling artwork). Metadata decorates the
library; it no longer gates it. The file is the source of truth, the provider
match is an optional enrichment the admin can apply later through the existing
**Identify** flow.

Non-goals (this plan): a periodic full-library scan, auto-matching
after the fact, local artwork for *matched* titles, a frame-extraction poster
(listed as optional at the end).

## What the audit found

Everything below is already true on `main`: the plan builds on it, nothing
here needs to be re-verified before starting.

**The data model already allows it.**

- `tmdbId` / `tvdbId` / `imdbId` are nullable
  (`backend/src/modules/media/entities/media.entity.ts`).
- `UQ_media_type_tmdbId` is a plain unique index → NULLS DISTINCT, any number
  of unmatched rows per type.
- `CreateMediaDto` requires only `title` + `type`.
- `MediaImportService.create()` and
  `MediaRescanService.linkExistingFileInPlace()` are the two bricks needed;
  no new entity, no migration.
- `applyIdentity()` / `completeIdentify()` work on a media with no id at all.
  The Identify modal is wired on the card and the detail page (admin only).
- Playback, social, playlists, markers, streaming never read `tmdbId`.
- `media-card.html` already renders the film-icon placeholder when
  `posterUrl` is null.

**The single blocker**: nothing creates a `Media` without an external id.

- `DiskImportService.relinkOrphans` requires `dto.externalId` and goes through
  `importMedia`, which reads the provider.
- `OrphanScanPanelComponent.importAll` skips every group without a pick.
- Files directly under the library root (`looseFiles`) are counted and thrown
  away (`media.path` needs a non-empty `folderName`).

**What breaks the day unmatched rows exist** (must be fixed *before* or *with*
the creation path):

1. Subtitle providers: `opensubtitles.provider.ts` and `subdl.provider.ts`
   only send `moviehash` / `imdb_id` / `tmdb_id`; `params.title` is never sent.
   A file with no hash and no id would query `languages=xx` alone and download
   an unrelated subtitle.
2. `SchedulerService.doRefreshMissingMetadata` picks `!posterUrl || !overview`
   and `doRefreshMetadata` picks anything not "settled"; both call
   `refreshMetadata`, which throws `No provider ID available` for every
   unmatched title, every night.
3. `monitored` defaults to `true`; an unmatched local title would trigger the
   release search on a filename-derived title.
4. Requests are keyed on `tmdbId` (NOT NULL column). `media-detail.ts` calls
   `loadTitleState(m.tmdbId)` → `?tmdbId=undefined` → 400, and the
   Request / Request-deletion gates read a wrong state.
5. `findByTmdbId` is the only "already in library" check, so an unmatched
   title is invisible to dedup (a user request for it re-downloads it).
6. Naming templates emit empty `{TMDB Id}` / `{Year}` → "reorganize" must be
   refused on an unmatched title.
7. `dropSeasonsAbsentFromProvider` after an Identify sets `episodeId` to NULL
   on files whose invented episode the provider does not list (pre-existing,
   becomes common).

## Decisions taken

- **No new column.** "Unmatched" is derived: `tmdbId == null && tvdbId == null
  && imdbId == null`. One helper each side (`isUnmatched(media)`), no
  `metadataSource` enum, no `identifiedAt`. Re-evaluate only if a later feature
  needs to distinguish "NFO-sourced" from "filename-sourced".
- **Unmatched rows are created with `monitored: false`,
  `status: RELEASED`, `metadataRefreshedAt: null`.** `RELEASED` keeps the
  detail page from labelling a file on disk "TBA" and keeps `isMetadataDue`
  logic sane; monitoring is the admin's explicit choice after an Identify.
- **Natural key for an unmatched title is `(libraryId, type, folderName)`.**
  Two scans of the same folder relink into the same row instead of creating a
  twin. Two folders with the same guessed title stay two titles.
- **Requests stay TMDB-keyed.** The Request / Request-deletion entries are
  hidden on an unmatched title (the admin identifies it first). Re-keying the
  requests table on `mediaId` is a separate project with no payoff here.
- **"Reorganize" is refused server-side for an unmatched title** (400), and
  the client never sends it for one. Linking is always in place.
- **Local `.nfo` and sibling artwork are read only for unmatched titles** in
  this plan. Applying a local-over-remote artwork preference to matched titles
  is a follow-up with its own precedence rules.
- **Files at the library root are their own PR** (Phase 5): they touch
  `media.path`, which feeds the folder deletion path.

## Phase 0: guards (ship first, safe on its own)

Nothing in this phase changes behaviour for matched titles. It closes the
three silent-guard holes so Phase 1 can't hurt anyone.

### 0.1 Subtitle providers send the title

- `opensubtitles.provider.ts`: `if (!params.moviehash && !params.imdbId &&
  !params.tmdbId) query.set('query', params.title)`. OpenSubtitles' `query`
  parameter is the documented free-text search.
- `subdl.provider.ts`: same shape with `film_name`.
- `SubtitlesService.searchSubtitles`: log at `warn` when a search runs with no
  hash and no id, the scorer already rates candidates by release name and
  title, so the results are usable, but the log makes a bad match diagnosable.
- Spec: one test per provider asserting the URL carries the title when ids
  and hash are absent, and does not when an id is present.

### 0.2 Schedulers skip titles with no provider id

- `scheduler.service.ts`: `doRefreshMetadata` and `doRefreshMissingMetadata`
  filter `allMedia` with `hasProviderId(m)` before building `dueMedia` /
  `candidates`. Log the skipped count once per run
  (`… (N unidentified title(s) skipped)`), not per title.
- `MediaMetadataService.refreshMetadata`: keep the throw (a manual refresh on
  an unmatched title must say why), the schedulers just stop calling it.
- Spec: `scheduler.service.spec.ts`: an unmatched row is neither refreshed
  nor counted as failed.

### 0.3 Client request gates tolerate a missing `tmdbId`

- `media-detail.ts`: `loadTitleState` / `loadDeleteRequestState` return early
  when `m.tmdbId == null`; `canRequest()` / `canRequestDeletion()` (or the
  template around the buttons) also require `tmdbId`.
- Same check anywhere else `m.tmdbId` is stringified into a URL (grep
  `tmdbId` in `client/src/app/features/media-detail/`).

PR title: `fix(metadata): guard subtitle search, refresh jobs and request gates against titles with no provider id`.

## Phase 1: backend, create an unmatched title from an orphan group

### 1.1 DTO

`RelinkOrphansDto` (`backend/src/modules/imports/dto/relink-orphans.dto.ts`):

- `externalId` → `@IsOptional()`. `provider` already optional.
- Add `title?: string` (`@IsOptional() @IsString() @MaxLength(255)`) and
  `year?: number` (`@IsOptional() @IsInt() @Min(1888) @Max(2100)`), used only
  when `externalId` is absent. Both come from the panel's editable query/year
  fields, so the admin's correction of the guessed title is what gets stored.
- Class-level rule: `externalId` absent + `reorganize: true` → 400
  (`Reorganize needs an identified title`). Do it in the service, not with a
  custom validator: one `if`, one exception.

### 1.2 Service branch

`DiskImportService.relinkOrphans`:

```ts
let media = dto.externalId
  ? await this.findOrImportIdentified(dto, addedByUserId)     // today's code
  : await this.findOrCreateUnmatched(dto, library, addedByUserId);
```

`findOrCreateUnmatched`:

1. `mediaRepo.findOne({ where: { library: { id }, type, folderName,
   tmdbId: IsNull(), tvdbId: IsNull(), imdbId: IsNull() } })` → reuse.
2. Otherwise `mediaImport.createUnmatched({ title, year, type, libraryId,
   folderName, qualityProfileId, languageProfileId }, addedByUserId)`.

`MediaImportService.createUnmatched` (next to `create()`):

- Resolves profiles through `profiles.resolveQualityProfileIdForImport` /
  `resolveLanguageProfileIdForImport` like `importMedia` does, so an Identify
  followed by "monitor" behaves like any other title.
- `mediaRepo.create({ title, originalTitle: title, year, type,
  status: MediaStatus.RELEASED, monitored: false, alternativeTitles: [],
  genres: [], library, folderName, addedBy })`.
- `updateSearchVector(saved.id)`.
- `events.emitDomain({ type: 'media.imported', tmdbId: null, … })`: the
  event is already typed `tmdbId: number | null`; `RequestLifecycleService.
  onMediaImported` already returns on `!media.tmdbId`.
- Log: `Library: added unidentified movie "<title>" (<year>), id=…`.

Everything after that in `relinkOrphans` is unchanged: pin `folderName`,
`linkExistingFileInPlace` per file, `postImportQueue.enqueue`, the
`media.files.imported` domain event. For a series the existing
`ensureSeasonAndEpisode` invents seasons/episodes from `SxxEyy`; skip the
`refreshSeriesEpisodes` backfill when the media has no id (it would throw).

### 1.3 Helper

`backend/src/modules/media/media-identity.util.ts` (or inside the entity as a
getter, pick the entity getter only if it doesn't need `@Expose`):

```ts
export const hasProviderId = (m: Pick<Media, 'tmdbId' | 'tvdbId' | 'imdbId'>) =>
  m.tmdbId != null || m.tvdbId != null || !!m.imdbId;
```

Used by Phase 0.2, by `relinkOrphans`, and by the `unidentified` filter in
Phase 3.

### 1.4 Tests

- `disk-import.unmatched.spec.ts` (same harness as
  `disk-import.orphan-scan.spec.ts`): no `externalId` → `createUnmatched`
  called with the guessed title/year, files linked in place, `created: true`;
  second call on the same folder reuses the row (`created: false`);
  `reorganize: true` without `externalId` → `BadRequestException`;
  series group → seasons/episodes created, `refreshSeriesEpisodes` not called.
- `media-import.service` spec: `createUnmatched` sets `monitored: false`,
  `status: released`, emits `media.imported` with `tmdbId: null`.

## Phase 2: client, the scan panel offers "add without metadata"

`client/src/app/features/settings/libraries/library-detail/orphan-scan-panel/`.

### 2.1 Group state

`GroupVM` gains nothing new: "unmatched" is `pick === null`. What changes is
what a null pick *means*: today it's "skip", after this it's "add as is".

- `relinkBody(libraryId, group, pick | null)`: when `pick` is null, omit
  `externalId`/`provider`, send `title: vm.query.trim() || group.guessTitle ||
  group.folderName`, `year: vm.year ?? undefined`, and force
  `reorganize: false`.
- `link(i)`: no longer requires `vm.pick`. Button label switches between
  `scan_link` / `scan_relink_existing` / new `scan_add_unmatched`
  ("Ajouter sans métadonnées").
- `importAll` (wizard path): every pending group is sent; `skipped` only
  counts groups whose request failed to build (in practice zero). Return
  `{ queued, unmatched }` so the wizard toast can say how many landed without
  metadata.
- `autoImportAll`: unchanged, it still picks the best provider match when
  there is one; when `bestMatch` returns null it now links unmatched instead
  of leaving the group behind.
- `pendingGroups` / `hasLinkable`: drop the `g.pick` condition.

### 2.2 Template

- Collapsed header badge: `vm.pick?.title` today; when null and the group
  has been searched, show a ghost badge `scan_unmatched_badge`
  ("Sans métadonnées").
- Search results list: add a first pseudo-row "Aucune correspondance : ajouter
  tel quel" that is selected when `pick` is null. This makes the deselect
  gesture (clicking the picked result again) discoverable instead of implicit.
- The `reorganize` toggle stays global; the link button tooltip says it is
  ignored for an unmatched title (`scan_reorganize_needs_match`).
- Wizard (`library-wizard.ts`): replace the `scan_unmatched` warning toast
  with an info toast `scan_queued_unmatched` ("{{count}} titre(s) ajouté(s)
  sans métadonnées, identifiez-les depuis l'onglet Médias").

### 2.3 i18n

Add to all six `client/public/i18n/*.json` under `settings.libraries`:
`scan_add_unmatched`, `scan_unmatched_badge`, `scan_unmatched_option`,
`scan_reorganize_needs_match`, `scan_queued_unmatched`. Retire
`scan_unmatched` (the "relaunch the scan" warning) once nothing reads it.

### 2.4 Tests

`orphan-scan-panel.spec.ts`: a group with no pick produces a body without
`externalId` and with `title`/`year`; `importAll` queues it; `reorganize` is
forced to `false` on that body.

PR (Phases 1 + 2 together, they are useless apart):
`feat(libraries): add unidentified titles from the orphan scan instead of skipping them`.

## Phase 3: display and admin tooling for unidentified titles

### 3.1 Detail page

`media-detail.ts` / `media-info-header`:

- Admin-only callout above the header when `!hasProviderId(m)`:
  "Ce titre n'est pas identifié. Les informations viennent du fichier." with
  the existing `media.identify` action as its button. The Identify entry in
  the actions menu stays; the callout is the discoverable path.
- Skip `getSimilar` / `getCollection` / cast loading when unmatched (they are
  provider-derived and would 404 or return empty).
- Runtime fallback: `runtime ?? Math.round(files[0].streamInfo.durationSeconds
  / 60)`; the header already takes `runtime` as an input.
- "Refresh metadata" action: when unmatched, open Identify instead (a refresh
  has nothing to refresh from). Gate on `hasProviderId` in
  `core-media-actions.ts`.
- Non-admin viewers see the title, year, file badges, playback controls and
  the placeholder; nothing else is claimed.

### 3.2 Cards and rows

No change to `media-card`. Optional: a tiny "?" corner badge for admins on
unmatched cards, skip unless the admin filter below proves insufficient.

### 3.3 Admin filter

- `SearchMediaDto`: `unidentified?: boolean` → `media-query.service.ts`
  `applyFilters`: `qb.andWhere('media."tmdbId" IS NULL AND media."tvdbId" IS
  NULL AND media."imdbId" IS NULL')`.
- Library detail → Media tab (`library-media.ts`): a "Non identifiés" toggle
  and a count chip, so the admin batch-identifies after a big import. The
  card's existing Identify action does the rest.

### 3.4 Tests

`media-query.applyfilters.spec.ts`: the `unidentified` filter clause.
`media-detail` spec: callout shown for admin + unmatched, hidden otherwise;
`getSimilar` not called when unmatched.

PR: `feat(media-detail): surface unidentified titles and let admins filter and identify them`.

## Phase 4: metadata from the disk

Applied only in `createUnmatched` and only when the field is still empty.

### 4.1 NFO beyond ids

`NfoMetadataService.parse` already reads `title`, `year`, `uniqueid`. Extend
`NfoIds` (rename to `NfoData`) with `plot`, `genres: string[]`, `runtime`
(minutes), `rating` (`<ratings><rating><value>` then `<rating>`), `premiered`
(ISO date), `originalTitle`. Kodi's schema is stable; this is ~25 lines of
cheerio. `readForVideoFile` merges per key the same way it does today.

`OrphanGroup.nfo` already flows to the client; the panel can prefill the
query field from `nfo.title` (it does) and the backend uses the full NFO at
create time, re-read server-side from the sample file rather than trusting
the client copy.

Spec: `nfo-metadata.service.spec.ts` (new): a full Kodi movie NFO and a
`tvshow.nfo`, plus malformed XML → `{}`.

### 4.2 Sibling artwork

`ImageService`: split `doDownloadAndStore` into "fetch bytes" and
`storeBuffer(buffer, type, id, variant, sourceKey)` (variants, sidecar, hash).
Add `storeFromDisk(absPath, type, id, variant)` whose sidecar `url` is
`file://<abs>@<mtimeMs>` so the cache-hit path stays valid.

`backend/src/modules/imports/local-artwork.util.ts`: pure candidate list,
the usual media-center sidecar conventions (Kodi-style names), first hit wins,
extensions `jpg|jpeg|png|webp`:

- Movie poster: `<basename>-poster`, `poster`, `folder`, `cover`, `movie`.
- Movie fanart: `<basename>-fanart`, `fanart`, `backdrop`.
- Series (folder-level): `poster`, `folder`, `fanart`, `backdrop`, `banner`
  (banner ignored for now), `logo`/`clearlogo` → `logo` variant.

`createUnmatched` calls the lookup for poster/fanart/logo and sets
`posterUrl`/`fanartUrl`/`logoUrl` from `storeFromDisk`. Best-effort: a bad
image is a `warn`, never a failed import.

Spec: `local-artwork.util.spec.ts` on a temp tree; `image.service.spec.ts`
for `storeFromDisk` (sidecar written, variants present, second call is a
cache hit).

### 4.3 Embedded tags (cheap, optional)

ffprobe already returns `format.tags`. If `tags.title` exists and the
filename-derived title is a bare release name, prefer `tags.title`. Only if
4.1/4.2 leave real gaps in practice, flag it, do not build it now.

PR: `feat(imports): read local nfo fields and sibling artwork for unidentified titles`.

## Phase 5: files directly under the library root

Today: `folderName: ''` → `media.path` getter returns `null` →
`linkExistingFileInPlace` refuses → the scan lists them as "skipped".

Decision: allow `folderName = ''` for **movies only** (a series is a folder by
definition) and make `media.path` fall back to `library.path`. Everything that
treats `media.path` as "the folder I own" must be audited because the root is
now a possible answer:

- `MediaMutationService.resolveSafeMediaDir`: already returns `null` when
  `resolvedDir === resolvedRoot`. Keep, add a spec asserting it.
- `LibraryIngestService.ingest`: refuse a media whose `folderName` is empty
  (a grab must never land loose files at the root). Today it throws on
  `!media.path`; it must throw on `!media.folderName` instead.
- `NamingService` rename / reorganize: refuse (already refused for
  unmatched; a root movie can be identified later, so check `folderName` too).
- `DiskImportService.scanLibraryOrphans` `linkedSet`: uses
  `f.media?.path ?? library.path`, fine.
- `doRescanMissingFiles` / `rescanMediaList`: a root movie's "folder" is the
  whole library; the rescan must only look at its own `relativePath`, not walk
  the root. Check `MediaRescanService.rescan` before enabling.
- Orphan scan: loose movie files become groups with `folderName: ''` and
  `groupKey: movie:<abs>`; `looseFiles` disappears from the result and the
  `scan_loose_skipped` string is retired.
- `MediaFile.relativePath` for a root movie is just the filename; the
  `relativePathUnderMediaRoot(library.path, abs)` helper handles it.
- Delete from the UI on a root movie: `diskPath` is `null` → only the DB row
  goes; the file stays. Say so in the confirm dialog (`media_detail.
  delete_no_folder`).

Spec: every bullet above gets one assertion; the destructive one
(`resolveSafeMediaDir` on a root movie) is mandatory.

PR: `feat(libraries): link movie files that sit directly under the library root`.

## Optional follow-ups (not planned)

- **Frame-extracted poster** when no artwork and no provider: the
  `ThumbnailService` sprite pipeline already decodes the file; a
  `-ss <10 %> -frames:v 1` extraction stored via `storeFromDisk` as `poster`
  is ~40 lines. Do it only if placeholders turn out to be a real complaint.
- **Local artwork for matched titles** (a local-over-remote artwork preference).
- **Dedup by title/year** in `findByTmdbId` callers so a request for an
  unmatched title that is already on disk is caught.
- **Auto-identify job** for unmatched titles (year + exact title from the
  provider's first result). The wizard already does this at scan time; a
  nightly retry adds risk of silent wrong matches for little gain.

## Rollout order and verification

| PR | Phases | Ships alone? | Verify |
|----|--------|--------------|--------|
| 1 | 0 | yes | unit specs; nightly job log shows the skipped count; subtitle search URL in the provider log carries `query=` |
| 2 | 1 + 2 | after PR 1 | dev stack: library wizard on a folder with one matched, one unmatched movie and one unmatched series → three rows, playback works on all three, `monitored=false` on the two unmatched, Identify on one of them swaps in the provider data and keeps the files |
| 3 | 3 | after PR 2 | admin sees the callout and the filter; a viewer sees title/year/placeholder and can play; Request buttons absent |
| 4 | 4 | after PR 2 | folder with `movie.nfo` + `poster.jpg`: plot, genres, poster appear without any provider call (network off in the container to be sure) |
| 5 | 5 | after PR 2 | `Movie (2020).mkv` at the root imports; deleting it from the UI removes the row and **not** the library folder |

Backend checks use the direct binaries (`node_modules/.bin/jest`,
`node_modules/.bin/tsc -p tsconfig.build.json`), not the `npx` wrappers. Client
builds go to `/tmp/fliks-verify` (`dist/` is root-owned on the dev machine).

## Open questions for the owner

1. Wizard default: when a group has no provider match, add it unmatched
   silently (with a count toast) or stop and ask? Plan assumes **add
   silently**, a library that shows everything is the point.
2. Should `autoImportAll` on the library page also link groups with *no*
   provider result as unmatched? Plan assumes **yes** (same rule as the
   wizard).
3. Is `RELEASED` acceptable as the status of every unmatched title, or should
   the detail page hide the status line entirely for them? Plan assumes
   **RELEASED**, hidden line is a one-line change if preferred.
