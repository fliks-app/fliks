CREATE UNIQUE INDEX IF NOT EXISTS "idx_playback_user_movie" ON "playback_states" ("userId", "mediaId") WHERE "episodeId" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_playback_user_episode" ON "playback_states" ("userId", "episodeId") WHERE "episodeId" IS NOT NULL;
