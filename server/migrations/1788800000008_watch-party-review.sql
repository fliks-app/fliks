-- A scheduled party's item is the head of its programme; a film FK on the row would delete the
-- party with the film.
UPDATE "watch_parties" SET "mediaId" = NULL, "mediaFileId" = NULL, "episodeId" = NULL
WHERE "status" = 'scheduled';

-- The programme holds an item once.
DELETE FROM "watch_party_items" a USING "watch_party_items" b
WHERE a."partyId" = b."partyId" AND a."mediaId" = b."mediaId"
  AND COALESCE(a."episodeId", 0) = COALESCE(b."episodeId", 0) AND b."position" < a."position";
CREATE UNIQUE INDEX "UQ_watch_party_items_item"
  ON "watch_party_items" ("partyId", "mediaId", COALESCE("episodeId", 0));

DELETE FROM "watch_party_proposals" p
WHERE p."episodeId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "episodes" e WHERE e."id" = p."episodeId");
ALTER TABLE "watch_party_proposals"
  ADD CONSTRAINT "FK_watch_party_proposals_episode" FOREIGN KEY ("episodeId") REFERENCES "episodes"("id") ON DELETE CASCADE;

UPDATE "watch_party_items" i SET "mediaFileId" = NULL
WHERE i."mediaFileId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "media_files" f WHERE f."id" = i."mediaFileId");
ALTER TABLE "watch_party_items"
  ADD CONSTRAINT "FK_watch_party_items_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE SET NULL;

CREATE INDEX "IDX_watch_party_votes_user" ON "watch_party_votes" ("userId");

-- System messages keep the row of an item, never its title: each viewer resolves it.
UPDATE "watch_party_messages" SET "system" = jsonb_set("system", '{args}', ("system"->'args') - 'title')
WHERE "system"->'args' ? 'title';

ALTER TABLE "watch_party_messages" RENAME CONSTRAINT "watch_party_messages_pkey" TO "PK_watch_party_messages";
ALTER TABLE "watch_party_messages" RENAME CONSTRAINT "watch_party_messages_partyId_fkey" TO "FK_watch_party_messages_party";
ALTER TABLE "watch_party_messages" RENAME CONSTRAINT "watch_party_messages_userId_fkey" TO "FK_watch_party_messages_user";
ALTER TABLE "watch_party_items" RENAME CONSTRAINT "watch_party_items_pkey" TO "PK_watch_party_items";
ALTER TABLE "watch_party_items" RENAME CONSTRAINT "watch_party_items_partyId_fkey" TO "FK_watch_party_items_party";
ALTER TABLE "watch_party_items" RENAME CONSTRAINT "watch_party_items_mediaId_fkey" TO "FK_watch_party_items_media";
ALTER TABLE "watch_party_items" RENAME CONSTRAINT "watch_party_items_episodeId_fkey" TO "FK_watch_party_items_episode";
