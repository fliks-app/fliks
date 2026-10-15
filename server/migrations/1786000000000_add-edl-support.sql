ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "edlEnabled" boolean NOT NULL DEFAULT true;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "edlAutoSkipCommercials" boolean NOT NULL DEFAULT true;

UPDATE "app_settings" SET "value" = "value" || ',.edl'
       WHERE "key" = 'companion_file_extensions' AND "value" <> ''
         AND ',' || replace(lower("value"), ' ', '') || ',' NOT LIKE '%,.edl,%'
         AND ',' || replace(lower("value"), ' ', '') || ',' NOT LIKE '%,edl,%';
