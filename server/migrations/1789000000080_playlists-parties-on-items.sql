ALTER TABLE "playlist_items" ADD COLUMN "itemId" integer;
ALTER TABLE "playlist_items" DISABLE TRIGGER set_updated_at;
UPDATE "playlist_items" SET "itemId" = COALESCE(item_of("mediaId", "episodeId"), "episodeId");
ALTER TABLE "playlist_items" ENABLE TRIGGER set_updated_at;

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "playlist_items" WHERE "itemId" IS NULL;
  IF n > 0 THEN RAISE NOTICE 'playlist_items: % row(s) without an item dropped', n; END IF;
END $$;
DELETE FROM "playlist_items" WHERE "itemId" IS NULL;
DELETE FROM "playlist_items" a USING "playlist_items" b
 WHERE a."playlistId" = b."playlistId" AND a."itemId" = b."itemId"
   AND (b."position", b."id") < (a."position", a."id");

DROP INDEX "UQ_playlist_items_movie", "UQ_playlist_items_episode",
           "IDX_playlist_items_mediaId", "IDX_playlist_items_episodeId";
ALTER TABLE "playlist_items"
  ALTER COLUMN "itemId" SET NOT NULL,
  ADD CONSTRAINT "FK_playlist_items_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "UQ_playlist_items_item" UNIQUE ("playlistId", "itemId"),
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId";
CREATE INDEX "IDX_playlist_items_itemId" ON "playlist_items" ("itemId");

ALTER TABLE "watch_parties" ADD COLUMN "itemId" integer;
UPDATE "watch_parties" SET "itemId" = COALESCE(item_of("mediaId", "episodeId"),
                                                (SELECT id FROM items WHERE id = "episodeId"))
 WHERE "mediaId" IS NOT NULL;

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "watch_parties"
   WHERE "mediaId" IS NOT NULL AND "itemId" IS NULL AND "status" <> 'ended';
  IF n > 0 THEN RAISE NOTICE 'watch_parties: % party(ies) without an item ended', n; END IF;
END $$;
UPDATE "watch_parties" SET "status" = 'ended', "endedAt" = COALESCE("endedAt", now())
 WHERE "mediaId" IS NOT NULL AND "itemId" IS NULL AND "status" <> 'ended';
UPDATE "watch_parties" SET "mediaFileId" = NULL WHERE "itemId" IS NULL;

ALTER TABLE "watch_parties"
  DROP CONSTRAINT "CHK_watch_parties_item_started",
  DROP CONSTRAINT "CHK_watch_parties_item_media",
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId",
  ADD CONSTRAINT "FK_watch_parties_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "CHK_watch_parties_item_started" CHECK ("status" <> 'live' OR "itemId" IS NOT NULL),
  ADD CONSTRAINT "CHK_watch_parties_item_file" CHECK ("itemId" IS NOT NULL OR "mediaFileId" IS NULL);
CREATE INDEX "IDX_watch_parties_itemId" ON "watch_parties" ("itemId");

ALTER TABLE "watch_party_items" ADD COLUMN "itemId" integer;
UPDATE "watch_party_items" SET "itemId" = COALESCE(item_of("mediaId", "episodeId"), "episodeId");

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "watch_party_items" WHERE "itemId" IS NULL;
  IF n > 0 THEN RAISE NOTICE 'watch_party_items: % row(s) without an item dropped', n; END IF;
END $$;
DELETE FROM "watch_party_items" WHERE "itemId" IS NULL;
DELETE FROM "watch_party_items" a USING "watch_party_items" b
 WHERE a."partyId" = b."partyId" AND a."itemId" = b."itemId" AND b."position" < a."position";

DROP INDEX "UQ_watch_party_items_item";
ALTER TABLE "watch_party_items"
  ALTER COLUMN "itemId" SET NOT NULL,
  ADD CONSTRAINT "FK_watch_party_items_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "UQ_watch_party_items_item" UNIQUE ("partyId", "itemId"),
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId";

ALTER TABLE "watch_party_proposals" ADD COLUMN "itemId" integer;
UPDATE "watch_party_proposals" SET "itemId" = COALESCE(item_of("mediaId", "episodeId"), "episodeId");

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "watch_party_proposals" WHERE "itemId" IS NULL;
  IF n > 0 THEN RAISE NOTICE 'watch_party_proposals: % row(s) without an item dropped', n; END IF;
END $$;
DELETE FROM "watch_party_proposals" WHERE "itemId" IS NULL;
DELETE FROM "watch_party_proposals" a USING "watch_party_proposals" b
 WHERE a."partyId" = b."partyId" AND a."itemId" = b."itemId"
   AND (b."createdAt", b."id") < (a."createdAt", a."id");

DROP INDEX "UQ_watch_party_proposals_item";
ALTER TABLE "watch_party_proposals"
  ALTER COLUMN "itemId" SET NOT NULL,
  ADD CONSTRAINT "FK_watch_party_proposals_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "UQ_watch_party_proposals_item" UNIQUE ("partyId", "itemId"),
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId";
CREATE INDEX "IDX_watch_party_proposals_itemId" ON "watch_party_proposals" ("itemId");
