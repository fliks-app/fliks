ALTER TABLE "item_parts" ADD COLUMN "version" integer;
UPDATE "item_parts" p SET "version" = v.n
  FROM (SELECT "itemId", "mediaFileId",
               row_number() OVER (PARTITION BY "itemId" ORDER BY "mediaFileId") - 1 AS n
          FROM "item_parts") v
 WHERE v."itemId" = p."itemId" AND v."mediaFileId" = p."mediaFileId";
ALTER TABLE "item_parts" ALTER COLUMN "version" SET NOT NULL,
  ADD CONSTRAINT "CK_item_parts_version" CHECK ("version" >= 0),
  ADD CONSTRAINT "UQ_item_parts_version_position" UNIQUE ("itemId", "version", "position");

ALTER TABLE "playback_states" ADD COLUMN "version" integer;
ALTER TABLE "playback_states" DISABLE TRIGGER set_updated_at;
UPDATE "playback_states" ps SET "version" = p."version"
  FROM "item_parts" p WHERE p."itemId" = ps."itemId" AND p."mediaFileId" = ps."mediaFileId";
ALTER TABLE "playback_states" ENABLE TRIGGER set_updated_at;

CREATE FUNCTION playback_states_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."mediaFileId" IS NOT NULL THEN
    NEW."version" := COALESCE((SELECT p."version" FROM item_parts p
                                WHERE p."itemId" = NEW."itemId" AND p."mediaFileId" = NEW."mediaFileId"),
                              NEW."version");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER playback_states_version BEFORE INSERT OR UPDATE OF "mediaFileId" ON "playback_states"
  FOR EACH ROW EXECUTE FUNCTION playback_states_version();

CREATE OR REPLACE FUNCTION item_of(media integer, episode integer) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN episode IS NULL
    THEN (SELECT min(id) FROM items WHERE "mediaId" = media AND "groupId" IS NULL HAVING count(*) = 1)
    ELSE (SELECT id FROM items WHERE id = episode AND "mediaId" = media) END
$$;

ALTER TABLE "collection_entries" DROP CONSTRAINT "PK_collection_entries",
  ADD COLUMN "id" SERIAL,
  ADD COLUMN "itemId" integer,
  ADD COLUMN "positionEnd" numeric,
  ADD COLUMN "positionLabel" text;
ALTER TABLE "collection_entries"
  ADD CONSTRAINT "PK_collection_entries" PRIMARY KEY ("id"),
  ADD CONSTRAINT "FK_collection_entries_item" FOREIGN KEY ("itemId", "mediaId")
    REFERENCES "items" ("id", "mediaId") ON DELETE CASCADE,
  ADD CONSTRAINT "UQ_collection_entries" UNIQUE NULLS NOT DISTINCT ("collectionId", "mediaId", "itemId"),
  ADD CONSTRAINT "CK_collection_entries_position_end"
    CHECK ("positionEnd" IS NULL OR ("position" IS NOT NULL AND "positionEnd" >= "position"));
CREATE INDEX "IDX_collection_entries_item_media" ON "collection_entries" ("itemId", "mediaId");
