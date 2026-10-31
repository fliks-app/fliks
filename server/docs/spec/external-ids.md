# Spec: external ids

The identity a catalog entity has in an outside system: a TMDB id, an IMDb id, later an OpenLibrary work, an ISBN, an ASIN, a MusicBrainz id. One table holds them for every entity, so a title can carry several providers and the same lookup serves every kind. The HTTP payloads still name the three video ids (`tmdbId`, `tvdbId`, `imdbId`, rule 14); the tables are the only change.

## Table

`external_ids(entity text, "entityId" integer, scope text, provider text, value text)`.

1. `entity` names the table `entityId` points into. Only `media` exists; persons join it later. The database has no foreign key (the target table depends on `entity`): a trigger on `media` deletes the rows of a removed media, so no write path cleans up by hand.
2. `provider` is the id namespace, a text under a `CHECK` like `media.type` (a Postgres enum cannot gain a value inside the migration transaction). The set is `tmdb`, `tvdb`, `imdb`; the registry is `fliks_domain::media::external_id::ExternalProvider`, whose `ALL`, `as_str` and `parse` back every use of the names. A provider is added by a registry variant and a migration that widens the `CHECK`.
3. `value` is the id as text, never empty. `tmdb` and `tvdb` values are canonical positive integers of at most 9 digits (a `CHECK`, so a numeric read cannot fail); `imdb` is any non-empty text. A provider whose ids are not numbers extends the `CHECK` with its own arm.
4. `scope` is the namespace the id is unique in: for a `media` row, its `type` (`movie|series`, a `CHECK`). TMDB numbers its movies and its shows separately, and so does TVDB, so `tmdb 1396` can name a movie and a series. `scope` repeats `media.type`; nothing else may change one without the other (rule 9).
5. Keys: `PRIMARY KEY (entity, "entityId", provider)` (a media has at most one id per provider) and `UNIQUE (entity, scope, provider, value)` (an id names one media of its kind). The unique key replaces `UQ_media_type_tmdbId`, and extends the same guarantee to `tvdb` and `imdb`, which had none.
6. `provider` and `scope` never carry a kind a media cannot have: adding a `MediaKind` widens the `scope` `CHECK` in the same migration as `media."type"`'s.

## Reads

7. `external_id(entity text, entityId integer, provider text) RETURNS text` (SQL, `STABLE`) is the one way a query reads the id of an entity: `external_id('media', m.id, 'tmdb')::integer` is NULL when the media has none. A lookup the other way is a plain `SELECT "entityId" FROM external_ids WHERE entity = 'media' AND scope = $kind AND provider = $p AND value = $v`; the Rust side wraps it in `media::external_ids::find`.
8. A media is *identified* when it has at least one `external_ids` row, whatever the provider (`media-query.md` rule `unidentified`, scheduler rule 23, ingest rule 86).

## Writes

9. `link(media, kind, provider, value)` sets the media's id for a provider (replacing its previous one) and answers `false`, writing nothing, when another media of the same kind already holds the value. `unlink(media, provider)` removes it. A `media."type"` change moves the media's rows to the new `scope` in the same transaction (`PUT /api/media/:id`, media-write rule 26); a clash is the `409` of rule 11.
10. A write that persists the ids of a title (import, create, identify, importers) treats a `false` link, or a unique violation, as the title being already in the library: `409 This title is already in the library` where the route answers one, and a per-title error entry where an importer collects them. An id filled in from a provider answer (refresh, cross-reference) that another media holds is skipped with a `WARN`, so the media that owns it keeps it and the refresh goes on.
11. Non-positive numeric ids and empty text are not ids: they are not stored, and a payload carrying one reads back `null`.
12. The ids of one title are written in the transaction that writes the title (`media` insert or update), and read back through rule 7, never from a copy.

## Migration

13. The migration creates the table, the `CHECK`s, the trigger and `external_id()`, backfills one row per non-null, positive or non-empty `media."tmdbId"`, `"tvdbId"` and `"imdbId"` with `scope = media.type`, then drops the three columns and `UQ_media_type_tmdbId`. There is no dual write and no copy kept.
14. `tvdbId` and `imdbId` had no unique constraint, so a database may hold two media of one kind with the same value. The backfill keeps the id on the lowest `media.id` and drops it from the others (a `NOTICE` counts them): the other titles lose that one id, nothing else. `tmdbId` could not repeat.
15. The wire is unchanged. `tmdbId`, `tvdbId`, `imdbId` stay on every media payload (`media-query.md`, `playlists.md`, `subtitles.md`, `libraries.md`), assembled with rule 7, `null` when absent, and every request body that takes them (`POST /api/media`, `PUT /api/media/:id`, `POST /api/media/:id/identify`) still names them.

## Not in scope

`requests."tmdbId"`, `persons."tmdbId"` and `persons.provider`, `media."tmdbCollectionId"` (a collection's id, not the title's) and the art keys of requests keep their columns; the request and importer writes move onto `(provider, value)` later. Where one of them looks a media up by `tmdbId` it goes through rule 7's lookup.
