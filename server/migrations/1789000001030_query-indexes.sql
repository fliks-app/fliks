-- Indexes matched to the ORDER BY and WHERE of the library grid, the watch history and the track list.

-- Library grid sorts `title` and `added` within one library (`media/list.rs` `order_sql`, `id` breaks ties).
CREATE INDEX "IDX_media_libraryId_title" ON "media" ("libraryId", "title", "id");
CREATE INDEX "IDX_media_libraryId_createdAt" ON "media" ("libraryId", "createdAt", "id");

-- Watch history: newest `playedAt` first among the plays that set it.
CREATE INDEX "IDX_playback_states_history" ON "playback_states" ("userId", "playedAt" DESC)
  WHERE "playedAt" IS NOT NULL;

-- Track list: default title sort.
CREATE INDEX "IDX_items_title_lower" ON "items" (lower("title"), "id");

-- Strict prefixes of `IDX_item_parts_mediaFileId_mediaId`, `IDX_items_mediaId_editionId` and the grid indexes above.
DROP INDEX "IDX_item_parts_mediaFileId";
DROP INDEX "IDX_items_mediaId";
DROP INDEX "IDX_media_libraryId";

-- Recently added sorts on the newest file of a media, kept by triggers (`media/list.rs` `recently_added`).
ALTER TABLE "media" ADD COLUMN "lastFileAddedAt" timestamptz;
CREATE INDEX "IDX_media_files_mediaId_createdAt" ON "media_files" ("mediaId", "createdAt");
DROP INDEX "IDX_media_files_mediaId";

CREATE FUNCTION refresh_media_last_file_added(target integer) RETURNS void LANGUAGE sql AS $$
  UPDATE media SET "lastFileAddedAt" = f.added
    FROM (SELECT MAX("createdAt") AS added FROM media_files WHERE "mediaId" = target) f
   WHERE media.id = target AND media."lastFileAddedAt" IS DISTINCT FROM f.added $$;

CREATE FUNCTION media_files_last_added() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE media SET "lastFileAddedAt" = NEW."createdAt"
     WHERE id = NEW."mediaId" AND ("lastFileAddedAt" IS NULL OR "lastFileAddedAt" < NEW."createdAt");
  ELSE
    PERFORM refresh_media_last_file_added(OLD."mediaId");
    IF TG_OP = 'UPDATE' AND NEW."mediaId" IS DISTINCT FROM OLD."mediaId" THEN
      PERFORM refresh_media_last_file_added(NEW."mediaId");
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER media_files_last_added AFTER INSERT OR DELETE ON "media_files"
  FOR EACH ROW EXECUTE FUNCTION media_files_last_added();
CREATE TRIGGER media_files_last_added_update AFTER UPDATE OF "mediaId", "createdAt" ON "media_files"
  FOR EACH ROW WHEN (OLD."mediaId" IS DISTINCT FROM NEW."mediaId" OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt")
  EXECUTE FUNCTION media_files_last_added();

-- A change of the derived "sortCreator" or "lastFileAddedAt" alone does not bump "updatedAt"
CREATE OR REPLACE FUNCTION media_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt"
     AND NOT ((NEW."sortCreator" IS DISTINCT FROM OLD."sortCreator"
               OR NEW."lastFileAddedAt" IS DISTINCT FROM OLD."lastFileAddedAt")
              AND to_jsonb(NEW) - 'sortCreator' - 'lastFileAddedAt' = to_jsonb(OLD) - 'sortCreator' - 'lastFileAddedAt') THEN
    NEW."updatedAt" = now();
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE "media" DISABLE TRIGGER set_updated_at;
UPDATE "media" SET "lastFileAddedAt" = f.added
  FROM (SELECT "mediaId", MAX("createdAt") AS added FROM "media_files" WHERE "mediaId" IS NOT NULL GROUP BY "mediaId") f
 WHERE f."mediaId" = "media".id;
ALTER TABLE "media" ENABLE TRIGGER set_updated_at;
CREATE INDEX "IDX_media_lastFileAddedAt" ON "media" ("lastFileAddedAt" DESC, "id");

-- Subsonic song search: the text `subsonic/catalog.rs` matches (track, album, album artists), kept by triggers.
ALTER TABLE "track_details" ADD COLUMN "searchText" text;

CREATE FUNCTION track_search_text(track_item integer, track_label text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(i.title, track_label, '') || ' ' || m.title || ' ' || COALESCE((SELECT string_agg(p.name, ' ' ORDER BY mc.position)
      FROM media_credits mc JOIN persons p ON p.id = mc."personId" WHERE mc."mediaId" = m.id AND mc.role = 'artist'), '')
    FROM items i JOIN media m ON m.id = i."mediaId" WHERE i.id = track_item $$;

CREATE FUNCTION refresh_track_search_text(album integer) RETURNS void LANGUAGE sql AS $$
  UPDATE track_details SET "searchText" = track_search_text("itemId", label)
   WHERE "mediaId" = album AND "searchText" IS DISTINCT FROM track_search_text("itemId", label) $$;

CREATE FUNCTION track_details_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchText" := track_search_text(NEW."itemId", NEW.label);
  RETURN NEW;
END $$;
CREATE TRIGGER track_details_search_text BEFORE INSERT OR UPDATE OF "itemId", "mediaId", label ON "track_details"
  FOR EACH ROW EXECUTE FUNCTION track_details_search_text();

-- `media` passes its own id, `media_credits` its "mediaId".
CREATE FUNCTION track_search_text_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'media' THEN
    PERFORM refresh_track_search_text(NEW.id);
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM refresh_track_search_text(OLD."mediaId"); END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW."mediaId" IS DISTINCT FROM OLD."mediaId") THEN
    PERFORM refresh_track_search_text(NEW."mediaId");
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER track_search_text AFTER UPDATE OF title ON "media"
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title) EXECUTE FUNCTION track_search_text_refresh();
CREATE TRIGGER track_search_text_insert AFTER INSERT ON "media_credits"
  FOR EACH ROW WHEN (NEW.role = 'artist') EXECUTE FUNCTION track_search_text_refresh();
CREATE TRIGGER track_search_text_delete AFTER DELETE ON "media_credits"
  FOR EACH ROW WHEN (OLD.role = 'artist') EXECUTE FUNCTION track_search_text_refresh();
CREATE TRIGGER track_search_text_update AFTER UPDATE ON "media_credits"
  FOR EACH ROW WHEN (OLD.role = 'artist' OR NEW.role = 'artist') EXECUTE FUNCTION track_search_text_refresh();

-- A track retitled or moved to another album recomputes its own row only.
CREATE FUNCTION items_track_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE track_details SET "searchText" = track_search_text("itemId", label)
   WHERE "itemId" = NEW.id AND "searchText" IS DISTINCT FROM track_search_text("itemId", label);
  RETURN NULL;
END $$;
CREATE TRIGGER track_search_text AFTER UPDATE OF title, "mediaId" ON "items"
  FOR EACH ROW WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD."mediaId" IS DISTINCT FROM NEW."mediaId")
  EXECUTE FUNCTION items_track_search_text();

CREATE FUNCTION persons_track_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_track_search_text(a."mediaId")
     FROM (SELECT DISTINCT "mediaId" FROM media_credits WHERE "personId" = NEW.id AND role = 'artist') a;
  RETURN NULL;
END $$;
CREATE TRIGGER track_search_text AFTER UPDATE OF name ON "persons"
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION persons_track_search_text();

UPDATE "track_details" SET "searchText" = track_search_text("itemId", label);
CREATE INDEX "IDX_track_details_searchText_trgm" ON "track_details" USING gin ("searchText" gin_trgm_ops);
