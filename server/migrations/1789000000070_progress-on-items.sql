CREATE FUNCTION item_of(media integer, episode integer) RETURNS integer
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN episode IS NULL
    THEN (SELECT id FROM items WHERE "mediaId" = media AND "groupId" IS NULL ORDER BY id LIMIT 1)
    ELSE (SELECT id FROM items WHERE id = episode AND "mediaId" = media) END
$$;

ALTER TABLE "playback_states" ADD COLUMN "itemId" integer;
ALTER TABLE "playback_states" DISABLE TRIGGER set_updated_at;
UPDATE "playback_states" SET "itemId" = item_of("mediaId", "episodeId");
UPDATE "playback_states" SET "itemId" = "episodeId"
 WHERE "itemId" IS NULL AND "episodeId" IN (SELECT id FROM items);
ALTER TABLE "playback_states" ENABLE TRIGGER set_updated_at;

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "playback_states" WHERE "itemId" IS NULL OR "userId" IS NULL;
  IF n > 0 THEN RAISE NOTICE 'playback_states: % row(s) without an item or a user dropped', n; END IF;
END $$;
DELETE FROM "playback_states" WHERE "itemId" IS NULL OR "userId" IS NULL;

DROP INDEX "idx_playback_user_movie", "idx_playback_user_episode",
           "IDX_227d23190a49e5c40c6a4ccedd", "IDX_a650813641a2f4136cfd6ae5a8";
ALTER TABLE "playback_states"
  DROP CONSTRAINT "FK_b01f3bfb9c8dcbca9c0030341b3",
  ADD CONSTRAINT "FK_playback_states_file" FOREIGN KEY ("mediaFileId")
    REFERENCES "media_files"("id") ON DELETE SET NULL,
  ALTER COLUMN "itemId" SET NOT NULL,
  ALTER COLUMN "userId" SET NOT NULL,
  ADD CONSTRAINT "FK_playback_states_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "UQ_playback_states_user_item" UNIQUE ("userId", "itemId"),
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId";
CREATE INDEX "IDX_playback_states_itemId" ON "playback_states" ("itemId");

ALTER TABLE "playback_history" ADD COLUMN "itemId" integer;
UPDATE "playback_history" SET "itemId" = COALESCE(item_of("mediaId", "episodeId"), "episodeId");

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "playback_history" WHERE "itemId" IS NULL;
  IF n > 0 THEN RAISE NOTICE 'playback_history: % row(s) without an item dropped', n; END IF;
END $$;
DELETE FROM "playback_history" WHERE "itemId" IS NULL;

ALTER TABLE "playback_history"
  ALTER COLUMN "itemId" SET NOT NULL,
  ADD CONSTRAINT "FK_playback_history_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  DROP COLUMN "mediaId",
  DROP COLUMN "episodeId";
CREATE INDEX "IDX_playback_history_item_playedAt" ON "playback_history" ("itemId", "playedAt");
