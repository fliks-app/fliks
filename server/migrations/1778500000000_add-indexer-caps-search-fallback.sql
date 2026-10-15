
      ALTER TABLE "indexers"
        ADD COLUMN IF NOT EXISTS "capsMovieSearch" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "capsTvSearch"    boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "capsSearchFallback" boolean NOT NULL DEFAULT false;
