ALTER TABLE "seasons" ADD COLUMN IF NOT EXISTS "overview" text;

ALTER TABLE "seasons" ADD COLUMN IF NOT EXISTS "airDate" character varying(10);
