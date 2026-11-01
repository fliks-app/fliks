DELETE FROM "media_metadata" WHERE "mediaId" IS NULL;
ALTER TABLE "media_metadata" RENAME TO "movie_details";
ALTER SEQUENCE "media_metadata_id_seq" RENAME TO "media_details_id_seq";
ALTER TABLE "movie_details" RENAME CONSTRAINT "PK_6c52273ad7331542bbce7ae4da1" TO "PK_movie_details";
ALTER TABLE "movie_details" RENAME CONSTRAINT "REL_62d457c000de0f01b2821a06ae" TO "UQ_movie_details_media";
ALTER TABLE "movie_details" ALTER COLUMN "mediaId" SET NOT NULL,
  ADD COLUMN "kind" text NOT NULL DEFAULT 'movie' CONSTRAINT "CK_movie_details_kind" CHECK ("kind" = 'movie');

CREATE TABLE "series_details" (
  "id" integer NOT NULL DEFAULT nextval('media_details_id_seq'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'series',
  "tagline" varchar,
  "popularity" double precision,
  "voteCount" integer,
  "originalLanguage" varchar,
  "productionCountries" jsonb,
  "productionCompanies" jsonb,
  "videos" jsonb,
  "keywords" jsonb,
  CONSTRAINT "PK_series_details" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_series_details_media" UNIQUE ("mediaId"),
  CONSTRAINT "CK_series_details_kind" CHECK ("kind" = 'series')
);
INSERT INTO "series_details" ("id", "createdAt", "updatedAt", "mediaId", "tagline", "popularity", "voteCount",
  "originalLanguage", "productionCountries", "productionCompanies", "videos", "keywords")
SELECT d."id", d."createdAt", d."updatedAt", d."mediaId", d."tagline", d."popularity", d."voteCount",
       d."originalLanguage", d."productionCountries", d."productionCompanies", d."videos", d."keywords"
  FROM "movie_details" d JOIN "media" m ON m."id" = d."mediaId" WHERE m."type" = 'series';
DELETE FROM "movie_details" d USING "media" m WHERE m."id" = d."mediaId" AND m."type" <> 'movie';

ALTER TABLE "movie_details" DROP CONSTRAINT "FK_62d457c000de0f01b2821a06ae6",
  ADD CONSTRAINT "FK_movie_details_media" FOREIGN KEY ("mediaId", "kind")
    REFERENCES "media" ("id", "type") ON DELETE CASCADE;
ALTER TABLE "series_details"
  ADD CONSTRAINT "FK_series_details_media" FOREIGN KEY ("mediaId", "kind")
    REFERENCES "media" ("id", "type") ON DELETE CASCADE;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "series_details" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION media_details_json(media integer) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('id', d.id, 'createdAt', iso_ms(d."createdAt"), 'updatedAt', iso_ms(d."updatedAt"),
    'budget', d.budget::text, 'revenue', d.revenue::text, 'tagline', d.tagline, 'popularity', d.popularity,
    'voteCount', d."voteCount", 'originalLanguage', d."originalLanguage",
    'productionCountries', d."productionCountries", 'productionCompanies', d."productionCompanies",
    'videos', d.videos, 'keywords', d.keywords)
    FROM movie_details d WHERE d."mediaId" = media
  UNION ALL
  SELECT jsonb_build_object('id', d.id, 'createdAt', iso_ms(d."createdAt"), 'updatedAt', iso_ms(d."updatedAt"),
    'budget', NULL, 'revenue', NULL, 'tagline', d.tagline, 'popularity', d.popularity,
    'voteCount', d."voteCount", 'originalLanguage', d."originalLanguage",
    'productionCountries', d."productionCountries", 'productionCompanies', d."productionCompanies",
    'videos', d.videos, 'keywords', d.keywords)
    FROM series_details d WHERE d."mediaId" = media
  LIMIT 1
$$;

CREATE TABLE "collections" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" text NOT NULL
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "collections" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE "collection_external_ids" (
  "collectionId" integer NOT NULL REFERENCES "collections" ("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "PK_collection_external_ids" PRIMARY KEY ("collectionId", "provider"),
  CONSTRAINT "UQ_collection_external_ids" UNIQUE ("provider", "value"),
  CONSTRAINT "CK_collection_external_ids_provider" CHECK ("provider" IN ('tmdb')),
  CONSTRAINT "CK_collection_external_ids_value" CHECK ("value" ~ '^[1-9][0-9]{0,8}$')
);
CREATE TABLE "collection_entries" (
  "collectionId" integer NOT NULL REFERENCES "collections" ("id") ON DELETE CASCADE,
  "mediaId" integer NOT NULL REFERENCES "media" ("id") ON DELETE CASCADE,
  "position" numeric CONSTRAINT "CK_collection_entries_position" CHECK ("position" >= 0),
  CONSTRAINT "PK_collection_entries" PRIMARY KEY ("collectionId", "mediaId")
);
CREATE INDEX "IDX_collection_entries_media" ON "collection_entries" ("mediaId");

CREATE TEMP TABLE "_tmdb_collections" AS
SELECT s.tid, s.name, nextval('collections_id_seq')::int AS id FROM (
  SELECT DISTINCT ON ("tmdbCollectionId") "tmdbCollectionId" AS tid, COALESCE("tmdbCollectionName", '') AS name
    FROM "media" WHERE "tmdbCollectionId" BETWEEN 1 AND 999999999
   ORDER BY "tmdbCollectionId", ("tmdbCollectionName" IS NULL), "metadataRefreshedAt" DESC NULLS LAST, "id" DESC
) s;
INSERT INTO "collections" ("id", "name") SELECT id, name FROM "_tmdb_collections";
INSERT INTO "collection_external_ids" ("collectionId", "provider", "value")
SELECT id, 'tmdb', tid::text FROM "_tmdb_collections";
INSERT INTO "collection_entries" ("collectionId", "mediaId")
SELECT c.id, m."id" FROM "media" m JOIN "_tmdb_collections" c ON c.tid = m."tmdbCollectionId";
DROP TABLE "_tmdb_collections";
ALTER TABLE "media" DROP COLUMN "tmdbCollectionId", DROP COLUMN "tmdbCollectionName";

CREATE VIEW "media_tmdb_collection" AS
SELECT DISTINCT ON (e."mediaId") e."mediaId", c."id" AS "collectionId", x."value"::int AS "tmdbId", c."name"
  FROM "collection_entries" e
  JOIN "collections" c ON c."id" = e."collectionId"
  JOIN "collection_external_ids" x ON x."collectionId" = c."id" AND x."provider" = 'tmdb'
 ORDER BY e."mediaId", c."id";
