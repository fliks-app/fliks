
      ALTER TABLE "download_history"
        ADD COLUMN IF NOT EXISTS "episodeId" int,
        ADD COLUMN IF NOT EXISTS "seasonId" int;


      ALTER TABLE "download_history"
        ADD CONSTRAINT "FK_download_history_episode"
        FOREIGN KEY ("episodeId") REFERENCES "episodes"("id")
        ON DELETE SET NULL;


      ALTER TABLE "download_history"
        ADD CONSTRAINT "FK_download_history_season"
        FOREIGN KEY ("seasonId") REFERENCES "seasons"("id")
        ON DELETE SET NULL;
