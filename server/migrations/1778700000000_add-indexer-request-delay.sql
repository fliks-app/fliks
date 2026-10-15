
      ALTER TABLE "indexers"
        ADD COLUMN IF NOT EXISTS "requestDelay" integer NOT NULL DEFAULT 2;
