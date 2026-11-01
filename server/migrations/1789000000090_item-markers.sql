ALTER TABLE "episode_markers" RENAME TO "item_markers";
ALTER SEQUENCE "episode_markers_id_seq" RENAME TO "item_markers_id_seq";
ALTER TABLE "item_markers" RENAME COLUMN "episodeId" TO "itemId";
ALTER TABLE "item_markers" RENAME COLUMN "type" TO "kind";
ALTER TABLE "item_markers" RENAME CONSTRAINT "FK_b4ef632c24f24a5e7b9c4e18a4e" TO "FK_item_markers_item";
ALTER TABLE "item_markers" RENAME CONSTRAINT "PK_47780a1be9b93671c0286aedc06" TO "PK_item_markers";

DO $$ DECLARE n bigint; BEGIN
  DELETE FROM "item_markers" WHERE "itemId" IS NULL OR "startSeconds" < 0 OR "endSeconds" <= "startSeconds";
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'item_markers: % unusable row(s) dropped', n; END IF;
END $$;

ALTER TABLE "item_markers"
  DROP CONSTRAINT "uq_episode_marker_type",
  ALTER COLUMN "itemId" SET NOT NULL,
  ALTER COLUMN "kind" TYPE text,
  ADD COLUMN "mediaFileId" integer,
  ADD COLUMN "title" text,
  ADD CONSTRAINT "CK_item_markers_kind" CHECK ("kind" IN ('chapter', 'intro', 'outro', 'recap', 'credits')),
  ADD CONSTRAINT "CK_item_markers_range" CHECK ("startSeconds" >= 0 AND "endSeconds" > "startSeconds"),
  ADD CONSTRAINT "CK_item_markers_file" CHECK (("kind" = 'chapter') = ("mediaFileId" IS NOT NULL)),
  ADD CONSTRAINT "FK_item_markers_part" FOREIGN KEY ("itemId", "mediaFileId")
    REFERENCES "item_parts" ("itemId", "mediaFileId") ON DELETE CASCADE;
CREATE UNIQUE INDEX "UQ_item_markers_item_kind" ON "item_markers" ("itemId", "kind") WHERE "kind" <> 'chapter';
CREATE INDEX "IDX_item_markers_item" ON "item_markers" ("itemId");
CREATE INDEX "IDX_item_markers_file" ON "item_markers" ("mediaFileId") WHERE "mediaFileId" IS NOT NULL;

CREATE FUNCTION probe_chapters(info jsonb)
RETURNS TABLE (n bigint, start_s float8, end_s float8, title text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT c.n, (c.v->>'startSeconds')::float8, (c.v->>'endSeconds')::float8, c.v->>'title'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(info->'chapters') = 'array'
                                   THEN info->'chapters' ELSE '[]'::jsonb END) WITH ORDINALITY AS c(v, n)
   WHERE jsonb_typeof(c.v->'startSeconds') = 'number' AND jsonb_typeof(c.v->'endSeconds') = 'number'
     AND (c.v->>'startSeconds')::float8 >= 0
     AND (c.v->>'endSeconds')::float8 > (c.v->>'startSeconds')::float8
$$;

CREATE FUNCTION item_parts_chapters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "item_markers" ("itemId", "mediaFileId", "kind", "startSeconds", "endSeconds", "title")
  SELECT NEW."itemId", NEW."mediaFileId", 'chapter', c.start_s, c.end_s, c.title
    FROM "media_files" f, probe_chapters(f."streamInfo") c
   WHERE f."id" = NEW."mediaFileId" ORDER BY c.n;
  RETURN NULL;
END $$;
CREATE TRIGGER item_parts_chapters AFTER INSERT ON "item_parts"
  FOR EACH ROW EXECUTE FUNCTION item_parts_chapters();

CREATE FUNCTION media_files_chapters() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "item_markers" WHERE "mediaFileId" = NEW."id" AND "kind" = 'chapter';
  INSERT INTO "item_markers" ("itemId", "mediaFileId", "kind", "startSeconds", "endSeconds", "title")
  SELECT p."itemId", p."mediaFileId", 'chapter', c.start_s, c.end_s, c.title
    FROM "item_parts" p, probe_chapters(NEW."streamInfo") c
   WHERE p."mediaFileId" = NEW."id" ORDER BY p."itemId", c.n;
  RETURN NULL;
END $$;
CREATE TRIGGER media_files_chapters AFTER UPDATE OF "streamInfo" ON "media_files"
  FOR EACH ROW WHEN (OLD."streamInfo"->'chapters' IS DISTINCT FROM NEW."streamInfo"->'chapters')
  EXECUTE FUNCTION media_files_chapters();

INSERT INTO "item_markers" ("itemId", "mediaFileId", "kind", "startSeconds", "endSeconds", "title")
SELECT p."itemId", p."mediaFileId", 'chapter', c.start_s, c.end_s, c.title
  FROM "item_parts" p JOIN "media_files" f ON f."id" = p."mediaFileId", probe_chapters(f."streamInfo") c
 ORDER BY p."itemId", p."mediaFileId", c.n;
