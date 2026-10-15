ALTER TABLE "subtitle_files" ADD COLUMN IF NOT EXISTS "syncFailed" boolean NOT NULL DEFAULT false;
