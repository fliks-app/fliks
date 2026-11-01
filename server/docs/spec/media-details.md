# Spec: media details

What a media carries beyond the columns every kind shares: its release dates, the per-kind detail tables and its collections.

## Release dates

`media_release_dates("mediaId" integer, kind text, date date)`.

1. `PRIMARY KEY ("mediaId", kind)`: one date per kind. `FOREIGN KEY ("mediaId") REFERENCES media (id) ON DELETE CASCADE`. `kind` is a text under a `CHECK` (`release`, `cinema`, `digital`, `physical`); the registry is `fliks_domain::media::release::ReleaseKind` (`ALL`, `as_str` the stored value, `wire_key` the media payload key, `event` the calendar event, `is_fallback`). An index on `date` serves the calendar window.
2. The wire keeps one key per kind on every media payload, `YYYY-MM-DD` or `null`: `release` is `releaseDate`, `cinema` is `inCinemas`, `digital` is `digitalRelease`, `physical` is `physicalRelease`. `release` is the generic date (a series' first air date, a movie's primary release); the other three are the movie's specific dates.
3. A reader joins `LEFT JOIN LATERAL (SELECT max(date) FILTER (WHERE kind = 'release') AS release_date, ... FROM media_release_dates WHERE "mediaId" = m.id) dates ON true` (`media::details::dates_join` where the query is built at run time, the checked ones inline the same text). The four columns are `NULL` when the media has no row of that kind; `media` itself carries no date.
4. A payload that serialises the whole `media` row with `to_jsonb` (`playlists.md`) appends the four wire keys from the same join, `YYYY-MM-DD` or `null`.
5. `set_release_dates(media, [(kind, date?)], keep_on_null)` writes in the caller's transaction: a given date is upserted (the row is untouched when the date is unchanged), a missing one deletes the row unless `keep_on_null`. Every writer passes the date as text and Postgres reads it with `::timestamptz::date`: a plain date keeps its day, a datetime keeps its day in the session time zone, and an unreadable text fails the write. It answers whether any row changed, so a caller that owns `media."updatedAt"` can bump it. A media removed meanwhile writes nothing.
6. Import (`media-write.md` rule 21) writes the four dates with the media in its transaction; the unmatched create writes `release` from the NFO `premiered`; `refreshMetadata` keeps a stored date when the provider sends none (`keep_on_null`); `POST` and `PUT /api/media` write `release` from `releaseDate`, where `null` on a `PUT` deletes the row. A `PUT` that changes only the date still refreshes `media."updatedAt"`.
7. Equal dates under two kinds are two rows; no date is invented and a null is never a row. A date outside the usual range is kept as it is.

## Calendar and counters

8. The calendar (`media-query.md` rules 47-51) reads `media_release_dates` for the kinds without groups (`MediaKind::has_seasons()` false) and the items' `airDate` for the kinds with groups. A kind's entries carry the media's own kind as `type`.
9. A media's entries are one per non-fallback date kind (`ReleaseKind::is_fallback` false) inside the window, in `ReleaseKind::ALL` order; the fallback kind (`release`) only when none of them is. `type` filters the two branches by `has_seasons()`.
10. The counters (`media-query.md` rule 35, `system.md` rule 12) are one `SELECT type, count(*) ... GROUP BY type`, folded through `MediaKind::ALL`: each kind's `MediaKind::count_key()` (`movies`, `series`) holds its count, zero when the kind has no row.

## Release date migration

11. `1789000000110_media-release-dates.sql` creates the table, copies every non-null value of `media."releaseDate"`, `"inCinemas"`, `"digitalRelease"` and `"physicalRelease"` as the row of its kind, then drops the four columns. The wire is unchanged.

## Detail tables

`movie_details` and `series_details` hold what a provider says about a title beyond the shared `media` columns: `id` (one sequence, `media_details_id_seq`, for both), `createdAt`, `updatedAt` (trigger), `"mediaId"`, `kind`, `tagline`, `popularity`, `"voteCount"`, `"originalLanguage"`, `"productionCountries"`, `"productionCompanies"`, `videos`, `keywords`; `movie_details` also has `budget` and `revenue` (bigint).

12. One row per media (`UNIQUE ("mediaId")`), none when the provider never answered. `kind` is `'movie'` or `'series'` under a `CHECK`, and `FOREIGN KEY ("mediaId", kind) REFERENCES media (id, type) ON DELETE CASCADE`: a row can only sit in the table of its media's kind.
13. `media_details_json(media)` builds the `metadata` object of the wire from whichever table holds the media, `NULL` when neither does: `id, createdAt, updatedAt` (`iso_ms`), `budget` and `revenue` (bigint as text, `null` for a series), `tagline, popularity, voteCount, originalLanguage, productionCountries, productionCompanies, videos, keywords`. The wire is the one `media_metadata` had; `kind` is not on it.
14. `write_details(media, kind, details)` upserts the row of the media's kind in the caller's transaction or pool: a `null` or absent scalar keeps the stored column, an absent list keeps it, a present one replaces it; a series row carries no `budget` or `revenue`.
15. A type change (`PUT /api/media/:id`, `media-write.md` rule 26) deletes the details row of the old kind before the type is written, since its data came from the other kind's provider record. `metadata` is `null` until the next refresh writes the new row.

## Collections

`collections(id, createdAt, updatedAt, name)`, `collection_external_ids("collectionId", provider, value)` and `collection_entries("collectionId", "mediaId", position numeric)`.

16. A collection is a named group of media. Its external ids have the shape of `media_external_ids`: `PRIMARY KEY ("collectionId", provider)`, `UNIQUE (provider, value)`, `provider` under a `CHECK` (`tmdb` only), `value` a positive 9-digit integer. A collection may have no external id.
17. `collection_entries` has `PRIMARY KEY ("collectionId", "mediaId")`, cascades on both sides, and an index on `"mediaId"`. `position` is `numeric >= 0` (a book series uses `1.5`) and `NULL` for a TMDB collection: readers order by `position NULLS LAST`, then by the media's `release` date, `year` and `id`.
18. The view `media_tmdb_collection("mediaId", "collectionId", "tmdbId", name)` gives the one collection of a media that has a `tmdb` id (the lowest collection id when there are several). It is where the wire's `tmdbCollectionId` and `tmdbCollectionName` come from (`null` without a row); no `media` column holds them.
19. `set_tmdb_collection(media, Some((tmdb_id, name)) | None)` runs in the caller's transaction under `pg_advisory_xact_lock(hashtext('collections:tmdb:' || value))`: it finds the collection by `('tmdb', value)` or creates it with its id row, sets its name, replaces the media's entries in collections that have a `tmdb` id by one entry in that one, and deletes a collection it left when no entry remains. `None` only removes. Import writes it with the media, `refreshMetadata` overwrites it (`null` clears).
20. Readers: the collection routes and the `collectionId` filter (`media-query.md`) address a collection by its tmdb value; a collection without a name is not listed.

## Details and collections migration

21. `1789000000120_media-details-collections.sql` deletes `media_metadata` rows without a media, renames the table to `movie_details` (ids, sequence and `updatedAt` trigger kept), moves the rows of series media into `series_details` with their ids, drops rows of any other kind, then creates `media_details_json`. It creates the three collection tables and one collection per distinct `media."tmdbCollectionId"` (the name of the most recently refreshed media, `''` when none has one) with its entries, then drops `"tmdbCollectionId"` and `"tmdbCollectionName"` from `media` and creates the view of rule 18. The wire is unchanged.
