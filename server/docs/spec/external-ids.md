# Spec: external ids

The identity a media has in an outside system: a TMDB id, an IMDb id, later an OpenLibrary work, an ISBN, an ASIN, a MusicBrainz id. One table holds them, so a title can carry several providers and the same lookup serves every kind. The HTTP payloads still name the three video ids (`tmdbId`, `tvdbId`, `imdbId`, rule 13); only the tables changed. Persons get their own table when they move off `persons."tmdbId"`.

## Table

`media_external_ids("mediaId" integer, kind text, provider text, value text)`.

1. `PRIMARY KEY ("mediaId", provider)`: a media has at most one id per provider. `FOREIGN KEY ("mediaId", kind) REFERENCES media (id, type) ON DELETE CASCADE ON UPDATE CASCADE` (backed by `UNIQUE (id, type)` on `media`): the rows go with their media, `kind` always equals `media.type`, and a `type` change moves the rows with it (`PUT /api/media/:id`, media-write rule 26; a clash on the unique index of rule 4 is the `409` of rule 11).
2. `provider` is the id namespace, a text under a `CHECK` like `media.type` (a Postgres enum cannot gain a value inside the migration transaction). The set is `tmdb`, `tvdb`, `imdb`; the registry is `fliks_domain::external_id::ExternalProvider` (`ALL`, `as_str`, `parse`, `label`, `is_numeric`, `is_unique`). A provider is added by a registry variant and a migration that widens the `CHECK`.
3. `value` is the id as text. The numeric providers (`tmdb`, `tvdb`, listed in the `CHECK`) hold canonical positive integers of at most 9 digits, so a numeric read cannot fail; any other provider holds free text until its own `CHECK` arm says otherwise.
4. `kind` is the media kind (`media.type`): TMDB numbers its movies and its shows separately, so `tmdb 1396` can name a movie and a series. A partial unique index `(kind, provider, value) WHERE provider = 'tmdb'` keeps what `UQ_media_type_tmdbId` kept: one media per kind and TMDB id. `tvdb` and `imdb` are not unique (TMDB splits one TVDB show into several, and a title can be catalogued twice). A plain index on `(provider, value)` serves the lookups.

## Reads

5. A query that carries the three ids joins `LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $a)::integer AS tmdb, ... FROM media_external_ids WHERE "mediaId" = m.id) ids ON true`, the provider names bound from `ExternalProvider::as_str()`; the three columns are NULL when the media has none.
6. A lookup the other way is `SELECT "mediaId" FROM media_external_ids WHERE kind = $kind AND provider = $p AND value = $v ORDER BY "mediaId" LIMIT 1`; the Rust side wraps it in `media::external_ids::find`. For a provider that is not unique the lowest media id answers.
7. A media is *identified* when it has at least one row, whatever the provider (`media-query.md` rule `unidentified`, scheduler rule 23, ingest rule 86).

## Writes

8. `link(media, kind, provider, value)` sets the media's id for a provider (replacing its previous one) and answers one of: linked; taken (the provider is unique and another media of the kind holds the value, nothing written); gone (the media no longer exists, the foreign key refused the row). `unlink(media, provider)` removes it.
9. A write that persists the ids of a title (import, create, identify, importers) treats `taken` as the title being already in the library: `409 This title is already in the library` where the route answers one, a per-title error entry where an importer collects them. An id filled in from a provider answer (refresh, cross-reference) that another media of the kind holds is skipped with a `WARN`, so the media that owns it keeps it and the refresh goes on. `gone` (a media removed meanwhile, which no row outlives) answers `404 Media #<id> not found` on a route that writes a media's ids, and ends a background write (refresh, cross-reference) without error and without a row. A TMDB id taken by a concurrent writer is `taken` as well: the `409` or the skip, never a `500`.
10. A non-positive or non-integer numeric id and an empty `imdbId` are not ids: they are not stored (a write of one removes the id, rule 8), and a payload carrying one reads back `null`.
11. The ids of one title are written in the transaction that writes the title where there is one, and read back through rule 5, never from a copy. Only a TMDB id can clash: identify (media-write rule 49) refuses it with its `409` before writing; a `PUT` or create that hits the unique index answers `409 This title is already in the library`.

## Migration

12. The migration adds `UNIQUE (id, type)` to `media`, creates the table, its `CHECK`s, the keys and indexes, backfills one row per non-empty `media."imdbId"` and per positive `"tmdbId"` and `"tvdbId"` (every value was already unique per kind for `tmdb`; the others are copied as they are), then drops the three columns and `UQ_media_type_tmdbId`. There is no dual write and no copy kept.
13. The wire is unchanged. `tmdbId`, `tvdbId`, `imdbId` stay on every media payload (`media-query.md`, `playlists.md`, `subtitles.md`, `libraries.md`), assembled with rule 5, `null` when absent, and every request body that takes them (`POST /api/media`, `PUT /api/media/:id`, `POST /api/media/:id/identify`) still names them.

## Requests

14. A request names its title by `(mediaType, provider, externalId)` (`requests.md` rule 5), the media kind and an id of a provider whose ids are unique per kind (`is_unique`: `tmdb` for `movie` and `series`), so one request names at most one media. It matches the media of that kind holding the same `(provider, value)` row, by rule 6's lookup; a media with no row matches no request. The migration of `requests` copies `"tmdbId"` into `('tmdb', "tmdbId"::text)` and drops the column; a row whose `"tmdbId"` is not a positive integer of at most 9 digits is dropped (it could never match a media).
15. Request art is keyed `<kind>-<provider>-<value>` (`image-store.md` rule 22).

## Not in scope

`persons."tmdbId"` and `persons.provider`, and `media."tmdbCollectionId"` (a collection's id, not the title's) keep their columns. Where one of them looks a media up by `tmdbId` it goes through rule 6's lookup.
