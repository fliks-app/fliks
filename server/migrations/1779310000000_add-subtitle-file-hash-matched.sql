
      ALTER TABLE "subtitle_files"
        ADD COLUMN IF NOT EXISTS "hashMatched" boolean NOT NULL DEFAULT false;
