ALTER TABLE "requests" ADD COLUMN "provider" text, ADD COLUMN "externalId" text;

UPDATE "requests" SET "provider" = 'tmdb', "externalId" = "tmdbId"::text
 WHERE "tmdbId" BETWEEN 1 AND 999999999;

DO $$ DECLARE n bigint; BEGIN
  DELETE FROM "requests" WHERE "provider" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE NOTICE 'requests: % row(s) without a valid tmdbId dropped', n; END IF;
END $$;

ALTER TABLE "requests"
  ALTER COLUMN "provider" SET NOT NULL,
  ALTER COLUMN "externalId" SET NOT NULL,
  ADD CONSTRAINT "CK_requests_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'imdb')),
  ADD CONSTRAINT "CK_requests_externalId" CHECK (
    "externalId" <> '' AND ("provider" NOT IN ('tmdb', 'tvdb') OR "externalId" ~ '^[1-9][0-9]{0,8}$')
  ),
  DROP COLUMN "tmdbId";

CREATE INDEX "IDX_requests_title" ON "requests" ("mediaType", "provider", "externalId");
