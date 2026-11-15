-- Indexes matched to the ORDER BY and WHERE of the library grid, the watch history and the track list.

-- Library grid sorts `title` and `added` within one library (`media/list.rs` `order_sql`, `id` breaks ties).
CREATE INDEX "IDX_media_libraryId_title" ON "media" ("libraryId", "title", "id");
CREATE INDEX "IDX_media_libraryId_createdAt" ON "media" ("libraryId", "createdAt", "id");

-- Watch history: newest `playedAt` first among the plays that set it.
CREATE INDEX "IDX_playback_states_history" ON "playback_states" ("userId", "playedAt" DESC)
  WHERE "playedAt" IS NOT NULL;

-- Track list: default title sort and the `q` ILIKE filter.
CREATE INDEX "IDX_items_title_lower" ON "items" (lower("title"), "id");
CREATE INDEX "IDX_items_title_trgm" ON "items" USING gin ("title" gin_trgm_ops);

-- Strict prefixes of `IDX_item_parts_mediaFileId_mediaId`, `IDX_items_mediaId_editionId` and the grid indexes above.
DROP INDEX "IDX_item_parts_mediaFileId";
DROP INDEX "IDX_items_mediaId";
DROP INDEX "IDX_media_libraryId";
