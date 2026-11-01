ALTER TABLE "media" ADD CONSTRAINT "UQ_media_id_type" UNIQUE ("id", "type");

CREATE TABLE "media_external_ids" (
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "PK_media_external_ids" PRIMARY KEY ("mediaId", "provider"),
  CONSTRAINT "FK_media_external_ids_media" FOREIGN KEY ("mediaId", "kind")
    REFERENCES "media" ("id", "type") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CK_media_external_ids_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'imdb')),
  CONSTRAINT "CK_media_external_ids_value" CHECK (
    "value" <> '' AND ("provider" NOT IN ('tmdb', 'tvdb') OR "value" ~ '^[1-9][0-9]{0,8}$')
  )
);

-- TMDB ids are unique per kind, as UQ_media_type_tmdbId was; tvdb and imdb ids never were.
CREATE UNIQUE INDEX "UQ_media_external_ids_tmdb" ON "media_external_ids" ("kind", "provider", "value")
  WHERE "provider" = 'tmdb';
CREATE INDEX "IDX_media_external_ids_lookup" ON "media_external_ids" ("provider", "value");

INSERT INTO "media_external_ids" ("mediaId", "kind", "provider", "value")
SELECT id, type, 'tmdb', "tmdbId"::text FROM "media" WHERE "tmdbId" BETWEEN 1 AND 999999999
UNION ALL
SELECT id, type, 'tvdb', "tvdbId"::text FROM "media" WHERE "tvdbId" BETWEEN 1 AND 999999999
UNION ALL
SELECT id, type, 'imdb', "imdbId" FROM "media" WHERE "imdbId" <> '';

DROP INDEX "UQ_media_type_tmdbId";
ALTER TABLE "media"
  DROP COLUMN "tmdbId",
  DROP COLUMN "tvdbId",
  DROP COLUMN "imdbId";
