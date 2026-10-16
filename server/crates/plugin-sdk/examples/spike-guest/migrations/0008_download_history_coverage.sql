ALTER TABLE "download_history"
    ADD COLUMN IF NOT EXISTS "coverSeasonFrom" integer,
    ADD COLUMN IF NOT EXISTS "coverSeasonTo" integer,
    ADD COLUMN IF NOT EXISTS "coverEpisodeFrom" integer,
    ADD COLUMN IF NOT EXISTS "coverEpisodeTo" integer,
    ADD COLUMN IF NOT EXISTS "coverCompleteSeries" boolean
