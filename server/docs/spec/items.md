# Spec: items, item groups, editions and item parts

What a media is made of. A movie is one item; a series is items (its episodes) gathered in item groups (its seasons). Every media also has an edition, the content variant its items and files belong to, and a file reaches the items it plays through item parts. The HTTP payloads speak of seasons and episodes (rule 11); only the tables are generic, so a later media kind reuses them.

## Tables

1. `item_groups(id, "mediaId" NOT NULL, number, monitored, "preferredProvider", "posterUrl", overview, "airDate")`: the seasons of a series, `number` being the season number (`0` for specials). `FOREIGN KEY ("mediaId") REFERENCES media ON DELETE CASCADE`, `UNIQUE (id, "mediaId")`, index on `"mediaId"`.
2. `editions(id, "mediaId", family, label)`: one content variant of a media. `family` is a text under `CHECK (family IN ('video'))`, widened with each new kind of content. `FOREIGN KEY ("mediaId") REFERENCES media ON DELETE CASCADE`, `UNIQUE (id, "mediaId")`. A media has exactly one `video` edition; a second edition would be different content (a cut), never another encoding of the same one.
3. `items(id, "mediaId", "editionId", "groupId", number, "endNumber", title, overview, "airDate", runtime, monitored, "stillUrl", "markersScannedAt", "searchVector")`: what is watched. `"mediaId"` and `"editionId"` are `NOT NULL`; `"groupId"` and `number` are null for the item of a movie. `FOREIGN KEY ("editionId", "mediaId") REFERENCES editions (id, "mediaId")` and `FOREIGN KEY ("groupId", "mediaId") REFERENCES item_groups (id, "mediaId")`, both `ON DELETE CASCADE`: the database refuses an item whose edition or group belongs to another media. `CHECK ("groupId" IS NULL OR number IS NOT NULL)`. `UNIQUE (id, "mediaId")`, index on `"mediaId"`. `"endNumber"` is the last episode number a multi-episode file covers, kept as display metadata (`endEpisodeNumber`) and as the range the parts follow (rule 19).
4. The shape of a media follows `MediaKind::has_seasons`: a series has groups and grouped items and no ungrouped item; a movie has exactly one ungrouped item and no group. Nothing else enforces it, so every write that creates a media or changes its type keeps it (rules 6-8).
5. Season and episode ids are the group and item ids: the migration renamed the tables in place, so `seasonId` and `episodeId` of every payload, `season/<id>` and `episode/<id>` image paths and the ids held by `episode_markers`, `subtitle_files`, `playback_states`, `playback_history`, `playlist_items`, `likes`, `content_recommendations`, `cleanup_*`, `watch_party_*` and `media_files` stayed valid. The item of a movie takes a fresh id from the same sequence.
6. Duplicate `(mediaId, number)` groups and `("groupId", number)` items are not constrained; lookups take the lowest id.

## Writes

7. `media::items::create_shell(conn, media, kind)` inserts the media's `video` edition and, when the kind has no seasons, its item (`monitored = true`, everything else null). Every `INSERT INTO media` calls it in the same transaction: `POST /api/media`, the title import, the unmatched media a disk import creates, and the Radarr and Sonarr importers. A route that creates a media without it breaks rule 4.
8. A group is inserted with its `"mediaId"`; an item of a series with the `"groupId"`, the group's `"mediaId"` and the media's `video` edition (`media::items::video_edition`).
9. `PUT /api/media/:id` changing `type` follows it (`media::items::follow_kind`): a media that becomes a series loses its ungrouped item; a media that becomes a movie gains one if it has none. Groups and grouped items are kept.
10. Deleting a media removes its editions, groups and items by cascade.

## Reads and wire

11. The wire is unchanged: `seasonId` is the group id, `seasonNumber` the group `number`, `episodeId` the id of a grouped item, `episodeNumber` its `number`, `endEpisodeNumber` its `"endNumber"`. SQL that builds those payloads names the keys (`jsonb_build_object` or an alias); no query serialises a whole `items` or `item_groups` row.
12. An ungrouped item is not an episode. A query about episodes joins `item_groups` on `"groupId"` or filters `"groupId" IS NOT NULL`, so the item of a movie never appears in an episode list, count or lookup (the episode gates of `PATCH /api/media/episodes/:episodeId` and of the markers routes answer `404` for it).
13. Progress and every other reference keep their columns (`playback_states."episodeId"`, ...); a movie's progress carries a null `episodeId`. A file carries no item: its items are its parts (rules 17-23).

## Versions and editions

14. Several files of one item are versions: the same content in other encodings, one picked at play time. An edition is different content. This change creates one `video` edition per media and never splits a movie.

## Migration

15. The migration renames `seasons` to `item_groups` and `episodes` to `items` (with their sequences, keys and indexes), renames `seasonNumber` to `number` on groups and `seasonId`, `episodeNumber`, `endEpisodeNumber` to `"groupId"`, `number`, `"endNumber"` on items. It deletes the groups without a media and the episodes without a season (they were unreachable, and their markers and progress go with them by cascade), creates the editions (one per media), then gives every item its media and edition, inserts one ungrouped item per movie and adds the keys and checks above. The episodes keep their `"updatedAt"`.
16. There is no dual write and no view over the old names.

## Item parts

17. `item_parts("itemId", "mediaFileId", "mediaId", position)`, primary key `("itemId", "mediaFileId")`, links a file to an item it plays. `FOREIGN KEY ("itemId", "mediaId") REFERENCES items (id, "mediaId")` and `FOREIGN KEY ("mediaFileId", "mediaId") REFERENCES media_files (id, "mediaId")`, both `ON DELETE CASCADE`: the database refuses a part whose file and item belong to different media, and a part goes with its file or its item. `CHECK (position >= 0)`, index on `"mediaFileId"`. `media_files` carries `UNIQUE (id, "mediaId")` for the key.
18. Parts of one item sharing a `position` are alternatives (versions): a reader picks one per position. Different positions are sequential pieces of one item. Every part is written at position `0`.
19. A file plays the item it was matched to and, when its name spans several episodes (`S01E02-E03`), every existing item of the same group numbered after the owner up to the last episode (`"endNumber"`). Missing items of the range are not created. When items are created, or a range is widened, the items inside it gain the parts of the range owner (`media::items::cover_ranges`). The range is stored on the owner item (`"endNumber"`), not on a file, so every part of the owner is spread, including a second version that is not a range.
20. A movie's files are parts of its ungrouped item. A series file whose episode is unknown has no part: it stays listed in the media's files, unassigned. A media that becomes a movie gives its new item a part for every file of the media (rule 9).
21. An item has a file when it has a part (`EXISTS (SELECT 1 FROM item_parts WHERE "itemId" = items.id)`). The `hasFile` column and the range coverage subqueries do not exist; an inner episode of a multi-episode file reports `hasFile: true`, and is counted as downloaded, like its owner. Every read about files and watching uses all the items that have a part: the watched flag of lists and `watched-ids`, the next episode of Continue Watching, the episode scope of cleanup and the count of downloaded episodes.
    - Finishing a file completes every item it plays: when a heartbeat or an offline replay completes an episode, each other grouped item with a part on the same file is completed too (a state row with position `0`, a play in the history, removal from auto playlists), like the series and season toggles do.
    - A file is listed once where a list names a file through an episode (the playable entries of a party programme or playlist) and where an upgrade is searched (acquisition): only its first item counts, tested through the item parts (no other part of the file has a lower number), so the inner episodes of a range are not offered a second time.
22. `media_file_items("mediaFileId", "itemId", "episodeId")` is a read-only view giving each file with parts one item: the lowest-numbered one (ungrouped first, then by id), which is the owner of a range. `"episodeId"` is that item's id when it is grouped, `NULL` for a movie's item: it is the `episodeId` of every file payload, stream token, subtitle and job, null for a movie's files and for a series file without episode.
23. Replacing a file's parts (a re-ingested path, a rescan link) deletes its parts and inserts them again in one transaction (`media::items::attach`).

## Item parts migration

24. The item-parts migration creates the table, then inserts a part for every file linked to an item of its own media, a part for every existing item inside the range of an owner with `"endNumber"`, and a part on the ungrouped item of every movie file. Files linked to an episode of another media stay unassigned (counted in a notice). It then drops `media_files."episodeId"`, `items."hasFile"` and the `("groupId", "hasFile", "endNumber")` index (replaced by an index on `("groupId", number)`), and creates `media_file_items`.
