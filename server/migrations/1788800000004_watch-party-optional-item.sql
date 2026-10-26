ALTER TABLE "watch_parties" ALTER COLUMN "mediaId" DROP NOT NULL;
ALTER TABLE "watch_parties"
  ADD CONSTRAINT "CHK_watch_parties_item_started" CHECK ("status" = 'scheduled' OR "mediaId" IS NOT NULL),
  ADD CONSTRAINT "CHK_watch_parties_item_media" CHECK ("mediaId" IS NOT NULL OR ("mediaFileId" IS NULL AND "episodeId" IS NULL));
