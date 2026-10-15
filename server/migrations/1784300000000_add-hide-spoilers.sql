ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hideSpoilers" boolean NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "spoilerHideStills" boolean NOT NULL DEFAULT true;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "spoilerHideOverviews" boolean NOT NULL DEFAULT true;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "spoilerHideTitles" boolean NOT NULL DEFAULT true;
