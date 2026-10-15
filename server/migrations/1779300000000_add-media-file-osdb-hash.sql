
      ALTER TABLE "media_files"
        ADD COLUMN IF NOT EXISTS "osdbHash" varchar(16),
        ADD COLUMN IF NOT EXISTS "osdbBytesize" bigint;
