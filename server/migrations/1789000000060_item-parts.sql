ALTER TABLE "media_files" ADD CONSTRAINT "UQ_media_files_id_media" UNIQUE ("id", "mediaId");

CREATE TABLE "item_parts" (
  "itemId" integer NOT NULL,
  "mediaFileId" integer NOT NULL,
  "mediaId" integer NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  CONSTRAINT "PK_item_parts" PRIMARY KEY ("itemId", "mediaFileId"),
  CONSTRAINT "FK_item_parts_item" FOREIGN KEY ("itemId", "mediaId")
    REFERENCES "items"("id", "mediaId") ON DELETE CASCADE,
  CONSTRAINT "FK_item_parts_file" FOREIGN KEY ("mediaFileId", "mediaId")
    REFERENCES "media_files"("id", "mediaId") ON DELETE CASCADE,
  CONSTRAINT "CK_item_parts_position" CHECK ("position" >= 0)
);
CREATE INDEX "IDX_item_parts_mediaFileId" ON "item_parts" ("mediaFileId");

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "media_files" f
   WHERE f."episodeId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "items" i WHERE i."id" = f."episodeId" AND i."mediaId" = f."mediaId");
  IF n > 0 THEN RAISE NOTICE 'item_parts: % file(s) linked to an episode of another media left unassigned', n; END IF;
END $$;

INSERT INTO "item_parts" ("itemId", "mediaFileId", "mediaId")
SELECT f."episodeId", f."id", f."mediaId" FROM "media_files" f
  JOIN "items" i ON i."id" = f."episodeId" AND i."mediaId" = f."mediaId";

INSERT INTO "item_parts" ("itemId", "mediaFileId", "mediaId")
SELECT j."id", p."mediaFileId", p."mediaId" FROM "items" o
  JOIN "item_parts" p ON p."itemId" = o."id"
  JOIN "items" j ON j."groupId" = o."groupId" AND j."number" > o."number" AND j."number" <= o."endNumber"
 WHERE o."endNumber" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "item_parts" ("itemId", "mediaFileId", "mediaId")
SELECT i."id", f."id", f."mediaId" FROM "items" i
  JOIN "media" m ON m."id" = i."mediaId" AND m."type" = 'movie'
  JOIN "media_files" f ON f."mediaId" = m."id"
 WHERE i."groupId" IS NULL;

DROP INDEX "IDX_items_group_hasfile_end";
DROP INDEX "IDX_media_files_episodeId";
ALTER TABLE "media_files" DROP COLUMN "episodeId";
ALTER TABLE "items" DROP COLUMN "hasFile";
CREATE INDEX "IDX_items_group_number" ON "items" ("groupId", "number");

CREATE VIEW "media_file_items" AS
SELECT DISTINCT ON (p."mediaFileId")
       p."mediaFileId", p."itemId", CASE WHEN i."groupId" IS NOT NULL THEN i."id" END AS "episodeId"
  FROM "item_parts" p JOIN "items" i ON i."id" = p."itemId"
 ORDER BY p."mediaFileId", i."number" NULLS FIRST, i."id";
