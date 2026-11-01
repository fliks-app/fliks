# Spec: media details

What a media carries beyond the columns every kind shares. Release dates today; the per-kind detail tables and collections follow in their own sections.

## Release dates

`media_release_dates("mediaId" integer, kind text, date date)`.

1. `PRIMARY KEY ("mediaId", kind)`: one date per kind. `FOREIGN KEY ("mediaId") REFERENCES media (id) ON DELETE CASCADE`. `kind` is a text under a `CHECK` (`release`, `cinema`, `digital`, `physical`); the registry is `fliks_domain::media::release::ReleaseKind` (`ALL`, `as_str` the stored value, `wire_key` the media payload key, `event` the calendar event, `is_fallback`). An index on `date` serves the calendar window.
2. The wire keeps one key per kind on every media payload, `YYYY-MM-DD` or `null`: `release` is `releaseDate`, `cinema` is `inCinemas`, `digital` is `digitalRelease`, `physical` is `physicalRelease`. `release` is the generic date (a series' first air date, a movie's primary release); the other three are the movie's specific dates.
3. A reader joins `LEFT JOIN LATERAL (SELECT max(date) FILTER (WHERE kind = 'release') AS release_date, ... FROM media_release_dates WHERE "mediaId" = m.id) dates ON true` (`media::details::dates_join` where the query is built at run time, the checked ones inline the same text). The four columns are `NULL` when the media has no row of that kind. No reader selects the dates from `media`: the columns do not exist.
4. A payload that serialises the whole `media` row with `to_jsonb` (`playlists.md`) appends the four keys from the same join, so dates print as `YYYY-MM-DD` and a missing one as `null`, exactly as the columns did.
5. `set_release_dates(media, [(kind, date?)], keep_on_null)` writes in the caller's transaction: a given date is upserted (the row is untouched when the date is unchanged), a missing one deletes the row unless `keep_on_null`. A text date goes through `::timestamptz::date`, so Postgres decides what it accepts, as it did for the columns. It answers whether any row changed, so a caller that owns `media."updatedAt"` can bump it. A media removed meanwhile writes nothing.
6. Import (`media-write.md` rule 21) writes the four dates with the media in its transaction; the unmatched create writes `release` from the NFO `premiered`; `refreshMetadata` keeps a stored date when the provider sends none (`keep_on_null`); `POST` and `PUT /api/media` write `release` from `releaseDate`, where `null` on a `PUT` deletes the row. A `PUT` that changes only the date still refreshes `media."updatedAt"`.
7. Equal dates under two kinds are two rows; no date is invented and a null is never a row. A date outside the usual range is kept as it is.

## Calendar and counters

8. The calendar (`media-query.md` rules 47-51) reads `media_release_dates` for the kinds without groups (`MediaKind::has_seasons()` false) and the items' `airDate` for the kinds with groups. A kind's entries carry the media's own kind as `type`.
9. A media's entries are one per non-fallback date kind (`ReleaseKind::is_fallback` false) inside the window, in `ReleaseKind::ALL` order; the fallback kind (`release`) only when none of them is. `type` filters the two branches by `has_seasons()`.
10. The counters (`media-query.md` rule 35, `system.md` rule 12) are one `SELECT type, count(*) ... GROUP BY type`, folded through `MediaKind::ALL`: each kind's `MediaKind::count_key()` (`movies`, `series`) holds its count, zero when the kind has no row.

## Migration

11. `1789000000110_media-release-dates.sql` creates the table, copies every non-null value of `media."releaseDate"`, `"inCinemas"`, `"digitalRelease"` and `"physicalRelease"` as the row of its kind, then drops the four columns. The wire is unchanged.
