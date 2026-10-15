ALTER TABLE "media"
         ADD COLUMN IF NOT EXISTS "alternativeTitles" jsonb
         NOT NULL DEFAULT '[]'::jsonb;
