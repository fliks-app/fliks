CREATE TABLE "external_ids" (
  "entity" text NOT NULL,
  "entityId" integer NOT NULL,
  "scope" text NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "PK_external_ids" PRIMARY KEY ("entity", "entityId", "provider"),
  CONSTRAINT "UQ_external_ids_value" UNIQUE ("entity", "scope", "provider", "value"),
  CONSTRAINT "CK_external_ids_entity" CHECK ("entity" = 'media'),
  CONSTRAINT "CK_external_ids_scope" CHECK ("scope" IN ('movie', 'series')),
  CONSTRAINT "CK_external_ids_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'imdb')),
  CONSTRAINT "CK_external_ids_value" CHECK (
    CASE WHEN "provider" = 'imdb' THEN "value" <> '' ELSE "value" ~ '^[1-9][0-9]{0,8}$' END
  )
);

CREATE FUNCTION external_id(text, integer, text) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT e."value" FROM external_ids e WHERE e."entity" = $1 AND e."entityId" = $2 AND e."provider" = $3
$$;

CREATE FUNCTION external_ids_delete_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM external_ids WHERE "entity" = 'media' AND "entityId" = OLD.id;
  RETURN OLD;
END $$;

CREATE TRIGGER external_ids_delete AFTER DELETE ON "media"
  FOR EACH ROW EXECUTE FUNCTION external_ids_delete_media();

CREATE TEMP TABLE "media_provider_ids" ON COMMIT DROP AS
  SELECT id, type AS scope, 'tmdb' AS provider, "tmdbId"::text AS value
    FROM "media" WHERE "tmdbId" BETWEEN 1 AND 999999999
  UNION ALL
  SELECT id, type, 'tvdb', "tvdbId"::text FROM "media" WHERE "tvdbId" BETWEEN 1 AND 999999999
  UNION ALL
  SELECT id, type, 'imdb', "imdbId" FROM "media" WHERE "imdbId" <> '';

-- tvdb and imdb ids were not unique: the lowest media id keeps a repeated one.
INSERT INTO "external_ids" ("entity", "entityId", "scope", "provider", "value")
SELECT DISTINCT ON (scope, provider, value) 'media', id, scope, provider, value
  FROM "media_provider_ids" ORDER BY scope, provider, value, id;

DO $$
DECLARE dropped bigint;
BEGIN
  SELECT (SELECT count(*) FROM "media_provider_ids") - (SELECT count(*) FROM "external_ids") INTO dropped;
  IF dropped > 0 THEN
    RAISE NOTICE 'external_ids: % repeated tvdb or imdb id(s) kept on the lowest media id only', dropped;
  END IF;
END $$;

DROP INDEX "UQ_media_type_tmdbId";
ALTER TABLE "media"
  DROP COLUMN "tmdbId",
  DROP COLUMN "tvdbId",
  DROP COLUMN "imdbId";
