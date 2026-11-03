-- A merge record belongs to an audio edition: another edition's merge no longer overwrites it.
ALTER TABLE "book_merges" ADD COLUMN "editionId" integer REFERENCES "editions"("id") ON DELETE CASCADE;
ALTER TABLE "book_merges" ADD COLUMN "merge" jsonb;
ALTER TABLE "book_merges" DISABLE TRIGGER set_updated_at;
UPDATE "book_merges" b SET "editionId" = (
  SELECT e.id FROM "editions" e WHERE e."mediaId" = b."mediaId" AND e.family = 'audio' ORDER BY e.id LIMIT 1);
ALTER TABLE "book_merges" ENABLE TRIGGER set_updated_at;
DELETE FROM "book_merges" WHERE "editionId" IS NULL;
ALTER TABLE "book_merges" ALTER COLUMN "editionId" SET NOT NULL;
ALTER TABLE "book_merges" DROP CONSTRAINT "book_merges_pkey";
ALTER TABLE "book_merges" ADD PRIMARY KEY ("editionId");
CREATE INDEX "IDX_book_merges_mediaId" ON "book_merges" ("mediaId");
ALTER TABLE "book_merges" DROP CONSTRAINT "CK_book_merges_state";
ALTER TABLE "book_merges" ADD CONSTRAINT "CK_book_merges_state"
  CHECK ("state" IN ('running', 'failed', 'retry', 'replace'));
