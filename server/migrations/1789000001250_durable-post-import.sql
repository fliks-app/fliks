-- Durable markers of the post-import work: a file is enriched once its crop and hash are stored,
-- a media is settled once its last settle ran past the newest file it holds.

ALTER TABLE "media_files" ADD COLUMN "enrichedAt" timestamptz;
ALTER TABLE "media" ADD COLUMN "settledAt" timestamptz;

-- Rows past the sweep window are never revisited; a recent file with a stored hash is done.
ALTER TABLE "media_files" DISABLE TRIGGER set_updated_at;
UPDATE "media_files" SET "enrichedAt" = now()
WHERE "osdbHash" IS NOT NULL OR "createdAt" <= now() - interval '7 days';
ALTER TABLE "media_files" ENABLE TRIGGER set_updated_at;
