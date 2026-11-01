CREATE TABLE "media_credits" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "editionId" integer,
  "personId" integer NOT NULL,
  "role" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "character" text,
  "job" text,
  "department" text,
  CONSTRAINT "FK_media_credits_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_media_credits_edition" FOREIGN KEY ("editionId", "mediaId")
    REFERENCES "editions"("id", "mediaId") ON DELETE CASCADE,
  CONSTRAINT "FK_media_credits_person" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE,
  CONSTRAINT "CK_media_credits_role" CHECK ("role" IN ('cast', 'crew', 'author', 'narrator', 'translator')),
  CONSTRAINT "CK_media_credits_cast" CHECK ("role" <> 'cast' OR "character" IS NOT NULL),
  CONSTRAINT "CK_media_credits_crew" CHECK ("role" <> 'crew' OR ("job" IS NOT NULL AND "department" IS NOT NULL))
);
CREATE INDEX "IDX_media_credits_media_role" ON "media_credits" ("mediaId", "role", "position");
CREATE INDEX "IDX_media_credits_person" ON "media_credits" ("personId", "role");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_credits" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$ DECLARE n bigint; BEGIN
  SELECT (SELECT count(*) FROM "media_cast" WHERE "mediaId" IS NULL OR "personId" IS NULL)
       + (SELECT count(*) FROM "media_crew" WHERE "mediaId" IS NULL OR "personId" IS NULL) INTO n;
  IF n > 0 THEN RAISE NOTICE 'media_credits: % cast or crew row(s) without media or person dropped', n; END IF;
END $$;

-- cast keeps its ids; crew takes fresh ones after them, in its old id order
INSERT INTO "media_credits" ("id", "createdAt", "updatedAt", "mediaId", "personId", "role", "position", "character")
SELECT "id", "createdAt", "updatedAt", "mediaId", "personId", 'cast', "order", "character"
  FROM "media_cast" WHERE "mediaId" IS NOT NULL AND "personId" IS NOT NULL;
SELECT setval('media_credits_id_seq', COALESCE(max("id"), 1), max("id") IS NOT NULL) FROM "media_credits";
INSERT INTO "media_credits" ("createdAt", "updatedAt", "mediaId", "personId", "role", "position", "job", "department")
SELECT "createdAt", "updatedAt", "mediaId", "personId", 'crew',
       (row_number() OVER (PARTITION BY "mediaId" ORDER BY "id") - 1)::int, "job", "department"
  FROM "media_crew" WHERE "mediaId" IS NOT NULL AND "personId" IS NOT NULL ORDER BY "id";
DROP TABLE "media_cast", "media_crew";

CREATE TABLE "person_external_ids" (
  "personId" integer NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "PK_person_external_ids" PRIMARY KEY ("personId", "provider"),
  CONSTRAINT "UQ_person_external_ids" UNIQUE ("provider", "value"),
  CONSTRAINT "FK_person_external_ids_person" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE,
  CONSTRAINT "CK_person_external_ids_provider" CHECK ("provider" IN ('tmdb', 'tvdb')),
  CONSTRAINT "CK_person_external_ids_value" CHECK ("value" ~ '^[1-9][0-9]{0,8}$')
);
INSERT INTO "person_external_ids" ("personId", "provider", "value")
SELECT "id", "provider", "tmdbId"::text FROM "persons"
 WHERE "provider" IN ('tmdb', 'tvdb') AND "tmdbId" BETWEEN 1 AND 999999999;

DO $$ DECLARE n bigint; BEGIN
  SELECT count(*) INTO n FROM "persons" p
   WHERE NOT EXISTS (SELECT 1 FROM "person_external_ids" x WHERE x."personId" = p."id");
  IF n > 0 THEN RAISE NOTICE 'person_external_ids: % person(s) with an unusable provider or id kept without id', n; END IF;
END $$;

ALTER TABLE "persons" DROP CONSTRAINT "UQ_677a19ecc46b5da7b1a4314c82b",
  DROP COLUMN "tmdbId", DROP COLUMN "provider";

CREATE VIEW "person_ids" AS
SELECT DISTINCT ON ("personId") "personId", "provider", "value"
  FROM "person_external_ids" ORDER BY "personId", ("provider" = 'tmdb') DESC, "provider";
