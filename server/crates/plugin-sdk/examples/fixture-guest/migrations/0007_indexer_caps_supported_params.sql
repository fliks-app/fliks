ALTER TABLE "indexers"
    ADD COLUMN IF NOT EXISTS "capsMovieSearchParams" text,
    ADD COLUMN IF NOT EXISTS "capsTvSearchParams" text
