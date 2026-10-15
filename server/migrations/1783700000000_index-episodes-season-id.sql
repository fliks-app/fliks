CREATE INDEX IF NOT EXISTS "idx_episodes_season_hasfile_end" ON "episodes" ("seasonId", "hasFile", "endEpisodeNumber");
