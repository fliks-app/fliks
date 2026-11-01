# Spec: items, item groups and editions

What a media is made of. A movie is one item; a series is items (its episodes) gathered in item groups (its seasons). Every media also has an edition, the content variant its items and files belong to. The HTTP payloads still speak of seasons and episodes (rule 11); only the tables are generic, so a later media kind reuses them.

## Tables

1. `item_groups(id, "mediaId" NOT NULL, number, monitored, "preferredProvider", "posterUrl", overview, "airDate")`: the seasons of a series, `number` being the season number (`0` for specials). `FOREIGN KEY ("mediaId") REFERENCES media ON DELETE CASCADE`, `UNIQUE (id, "mediaId")`, index on `"mediaId"`.
2. `editions(id, "mediaId", family, label)`: one content variant of a media. `family` is a text under `CHECK (family IN ('video'))`, widened with each new kind of content. `FOREIGN KEY ("mediaId") REFERENCES media ON DELETE CASCADE`, `UNIQUE (id, "mediaId")`. A media has exactly one `video` edition; a second edition would be different content (a cut), never another encoding of the same one.
3. `items(id, "mediaId", "editionId", "groupId", number, "endNumber", title, overview, "airDate", runtime, monitored, "hasFile", "stillUrl", "markersScannedAt", "searchVector")`: what is watched. `"mediaId"` and `"editionId"` are `NOT NULL`; `"groupId"` and `number` are null for the item of a movie. `FOREIGN KEY ("editionId", "mediaId") REFERENCES editions (id, "mediaId")` and `FOREIGN KEY ("groupId", "mediaId") REFERENCES item_groups (id, "mediaId")`, both `ON DELETE CASCADE`: the database refuses an item whose edition or group belongs to another media. `CHECK ("groupId" IS NULL OR number IS NOT NULL)`. `UNIQUE (id, "mediaId")`, index on `"mediaId"`. `"endNumber"` is the last episode number a multi-episode file covers.
4. The shape of a media follows `MediaKind::has_seasons`: a series has groups and grouped items and no ungrouped item; a movie has exactly one ungrouped item and no group. Nothing else enforces it, so every write that creates a media or changes its type keeps it (rules 6-8).
5. Season and episode ids are the group and item ids: the migration renamed the tables in place, so `seasonId` and `episodeId` of every payload, `season/<id>` and `episode/<id>` image paths and the ids held by `episode_markers`, `subtitle_files`, `playback_states`, `playback_history`, `playlist_items`, `likes`, `content_recommendations`, `cleanup_*`, `watch_party_*` and `media_files` stayed valid. The item of a movie takes a fresh id from the same sequence.
6. Duplicate `(mediaId, number)` groups and `("groupId", number)` items are not constrained; lookups take the lowest id.

## Writes

7. `media::items::create_shell(conn, media, kind)` inserts the media's `video` edition and, when the kind has no seasons, its item (`monitored = true`, `hasFile = false`, everything else null). Every `INSERT INTO media` calls it in the same transaction: `POST /api/media`, the title import, the unmatched media a disk import creates, and the importers (Radarr, Sonarr, Seerr). A route that creates a media without it breaks rule 4.
8. A group is inserted with its `"mediaId"`; an item of a series with the `"groupId"`, the group's `"mediaId"` and the media's `video` edition (`media::items::video_edition`).
9. `PUT /api/media/:id` changing `type` follows it (`media::items::follow_kind`): a media that becomes a series loses its ungrouped item; a media that becomes a movie gains one if it has none. Groups and grouped items are kept.
10. Deleting a media removes its editions, groups and items by cascade.

## Reads and wire

11. The wire is unchanged: `seasonId` is the group id, `seasonNumber` the group `number`, `episodeId` the id of a grouped item, `episodeNumber` its `number`, `endEpisodeNumber` its `"endNumber"`. SQL that builds those payloads names the keys (`jsonb_build_object` or an alias); no query serialises a whole `items` or `item_groups` row.
12. An ungrouped item is not an episode. A query about episodes joins `item_groups` on `"groupId"` or filters `"groupId" IS NOT NULL`, so the item of a movie never appears in an episode list, count or lookup (the episode gates of `PATCH /api/media/episodes/:episodeId` and of the markers routes answer `404` for it).
13. Files, progress and every other reference keep their columns (`media_files."episodeId"`, `playback_states."episodeId"`, ...); a movie's files and progress still carry a null `episodeId`.

## Versions and editions

14. Several files of one item are versions: the same content in other encodings, one picked at play time. An edition is different content. This change creates one `video` edition per media and never splits a movie.

## Migration

15. The migration renames `seasons` to `item_groups` and `episodes` to `items` (with their sequences, keys and indexes), renames `seasonNumber` to `number` on groups and `seasonId`, `episodeNumber`, `endEpisodeNumber` to `"groupId"`, `number`, `"endNumber"` on items. It deletes the groups without a media and the episodes without a season (they were unreachable, and their markers and progress go with them by cascade), creates the editions (one per media), then gives every item its media and edition, inserts one ungrouped item per movie (`"hasFile"` set once from its files) and adds the keys and checks above. The episodes keep their `"updatedAt"`.
16. There is no dual write and no view over the old names.
