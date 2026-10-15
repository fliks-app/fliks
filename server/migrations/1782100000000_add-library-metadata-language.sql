ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "metadataLanguage" character varying(8);

ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "metadataRegion" character varying(8);
