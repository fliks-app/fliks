ALTER TABLE "seasons" RENAME TO "item_groups";
ALTER TABLE "item_groups" RENAME COLUMN "seasonNumber" TO "number";
ALTER SEQUENCE "seasons_id_seq" RENAME TO "item_groups_id_seq";
ALTER TABLE "item_groups" RENAME CONSTRAINT "PK_cb8ed53b5fe109dcd4a4449ec9d" TO "PK_item_groups";
ALTER INDEX "IDX_seasons_mediaId" RENAME TO "IDX_item_groups_mediaId";
DELETE FROM "item_groups" WHERE "mediaId" IS NULL;
ALTER TABLE "item_groups"
  ALTER COLUMN "mediaId" SET NOT NULL,
  ADD CONSTRAINT "UQ_item_groups_id_media" UNIQUE ("id", "mediaId");

ALTER TABLE "episodes" RENAME TO "items";
ALTER TABLE "items" RENAME COLUMN "seasonId" TO "groupId";
ALTER TABLE "items" RENAME COLUMN "episodeNumber" TO "number";
ALTER TABLE "items" RENAME COLUMN "endEpisodeNumber" TO "endNumber";
ALTER SEQUENCE "episodes_id_seq" RENAME TO "items_id_seq";
ALTER TABLE "items" RENAME CONSTRAINT "PK_6a003fda8b0473fffc39cb831c7" TO "PK_items";
ALTER TABLE "items" ALTER COLUMN "number" DROP NOT NULL;
DELETE FROM "items" WHERE "groupId" IS NULL;

CREATE TABLE "editions" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "family" text NOT NULL,
  "label" text,
  CONSTRAINT "FK_editions_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
  CONSTRAINT "UQ_editions_id_media" UNIQUE ("id", "mediaId"),
  CONSTRAINT "CK_editions_family" CHECK ("family" IN ('video'))
);
CREATE INDEX "IDX_editions_mediaId" ON "editions" ("mediaId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "editions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
INSERT INTO "editions" ("mediaId", "family") SELECT "id", 'video' FROM "media" ORDER BY "id";

ALTER TABLE "items" DISABLE TRIGGER set_updated_at;
ALTER TABLE "items" ADD COLUMN "mediaId" integer, ADD COLUMN "editionId" integer;
UPDATE "items" i SET "mediaId" = g."mediaId", "editionId" = e."id"
  FROM "item_groups" g JOIN "editions" e ON e."mediaId" = g."mediaId" WHERE g."id" = i."groupId";
INSERT INTO "items" ("mediaId", "editionId", "monitored", "hasFile")
SELECT m."id", e."id", true, EXISTS (SELECT 1 FROM "media_files" f WHERE f."mediaId" = m."id")
  FROM "media" m JOIN "editions" e ON e."mediaId" = m."id"
 WHERE m."type" = 'movie'
 ORDER BY m."id";
ALTER TABLE "items" ENABLE TRIGGER set_updated_at;

ALTER TABLE "items" DROP CONSTRAINT "FK_b312e9d94c9b80adee2330b73e9";
ALTER TABLE "items"
  ALTER COLUMN "mediaId" SET NOT NULL,
  ALTER COLUMN "editionId" SET NOT NULL,
  ADD CONSTRAINT "UQ_items_id_media" UNIQUE ("id", "mediaId"),
  ADD CONSTRAINT "FK_items_edition" FOREIGN KEY ("editionId", "mediaId")
    REFERENCES "editions"("id", "mediaId") ON DELETE CASCADE,
  ADD CONSTRAINT "FK_items_group" FOREIGN KEY ("groupId", "mediaId")
    REFERENCES "item_groups"("id", "mediaId") ON DELETE CASCADE,
  ADD CONSTRAINT "CK_items_grouped_number" CHECK ("groupId" IS NULL OR "number" IS NOT NULL);
CREATE INDEX "IDX_items_mediaId" ON "items" ("mediaId");
ALTER INDEX "idx_episodes_season_hasfile_end" RENAME TO "IDX_items_group_hasfile_end";
