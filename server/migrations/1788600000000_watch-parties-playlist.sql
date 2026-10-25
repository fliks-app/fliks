ALTER TABLE "watch_parties" ADD COLUMN IF NOT EXISTS "playlistId" int;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_watch_parties_playlist') THEN
    ALTER TABLE "watch_parties"
      ADD CONSTRAINT "FK_watch_parties_playlist" FOREIGN KEY ("playlistId")
      REFERENCES "playlists"("id") ON DELETE SET NULL;
  END IF;
END $$;
