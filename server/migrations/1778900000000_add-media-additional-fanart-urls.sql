
      ALTER TABLE "media"
        ADD COLUMN IF NOT EXISTS "additionalFanartUrls" text[] NOT NULL DEFAULT '{}';
