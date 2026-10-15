
      ALTER TABLE "media"
        ADD COLUMN IF NOT EXISTS "tmdbCollectionId"   integer,
        ADD COLUMN IF NOT EXISTS "tmdbCollectionName" character varying;
