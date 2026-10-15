
      ALTER TABLE "requests"
        ADD COLUMN IF NOT EXISTS "posterUrl" text,
        ADD COLUMN IF NOT EXISTS "fanartUrl" text;
