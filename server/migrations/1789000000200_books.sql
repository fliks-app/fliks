-- Kind and families (items.md rule 39: a kind CHECK lists MediaKind::ALL, a family CHECK the families some kind is wished in)
ALTER TABLE "media" DROP CONSTRAINT "CK_media_type",
  ADD CONSTRAINT "CK_media_type" CHECK ("type" IN ('movie', 'series', 'book'));
ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_mediaType",
  ADD CONSTRAINT "CK_requests_mediaType" CHECK ("mediaType" IN ('movie', 'series', 'book'));
ALTER TABLE "user_quotas" DROP CONSTRAINT "CK_user_quotas_kind",
  ADD CONSTRAINT "CK_user_quotas_kind" CHECK ("kind" IN ('movie', 'series', 'book'));
ALTER TABLE "cleanup_rules" DROP CONSTRAINT "cleanup_rules_levels_check",
  ADD CONSTRAINT "CK_cleanup_rules_levels"
    CHECK (cardinality("levels") >= 1 AND "levels" <@ ARRAY['movie', 'series', 'season', 'episode', 'book']);
ALTER TABLE "editions" DROP CONSTRAINT "CK_editions_family",
  ADD CONSTRAINT "CK_editions_family" CHECK ("family" IN ('video', 'audio', 'text'));
ALTER TABLE "wants" DROP CONSTRAINT "CK_wants_family",
  ADD CONSTRAINT "CK_wants_family" CHECK ("family" IN ('video', 'audio', 'text'));
ALTER TABLE "quality_profiles" DROP CONSTRAINT "CK_quality_profiles_family",
  ADD CONSTRAINT "CK_quality_profiles_family" CHECK ("family" IN ('video', 'audio', 'text'));
ALTER TABLE "quality_definitions" DROP CONSTRAINT "CK_quality_definitions_family",
  ADD CONSTRAINT "CK_quality_definitions_family" CHECK ("family" IN ('video', 'audio', 'text'));

-- Work-level detail row (media-details.md rule 12: one details table per kind)
CREATE TABLE "book_details" (
  "id" integer NOT NULL DEFAULT nextval('media_details_id_seq'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'book',
  "subtitle" text,
  "originalLanguage" text,
  "subjects" jsonb,
  CONSTRAINT "PK_book_details" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_book_details_media" UNIQUE ("mediaId"),
  CONSTRAINT "CK_book_details_kind" CHECK ("kind" = 'book'),
  CONSTRAINT "FK_book_details_media" FOREIGN KEY ("mediaId", "kind") REFERENCES "media"("id", "type")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IDX_book_details_media_kind" ON "book_details" ("mediaId", "kind");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "book_details" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION media_details_json(media integer) RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE AS $$
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
  UNION ALL
  SELECT jsonb_build_object('id', d.id, 'createdAt', iso_ms(d."createdAt"), 'updatedAt', iso_ms(d."updatedAt"),
    'budget', NULL, 'revenue', NULL, 'tagline', NULL, 'popularity', NULL,
    'voteCount', NULL, 'originalLanguage', d."originalLanguage",
    'productionCountries', NULL, 'productionCompanies', NULL,
    'videos', NULL, 'keywords', NULL)
    FROM book_details d WHERE d."mediaId" = media
  LIMIT 1
$$;

-- Edition facts
ALTER TABLE "editions"
  ADD COLUMN "language" text,
  ADD COLUMN "title" text,
  ADD COLUMN "format" text,
  ADD COLUMN "coverUrl" text,
  ADD COLUMN "publisher" text,
  ADD COLUMN "durationSeconds" integer CONSTRAINT "CK_editions_duration" CHECK ("durationSeconds" > 0),
  ADD COLUMN "pageCount" integer CONSTRAINT "CK_editions_pages" CHECK ("pageCount" > 0),
  ADD COLUMN "libraryId" integer,
  ADD CONSTRAINT "CK_editions_format" CHECK ("format" ~ '^[a-z0-9]{1,8}$'),
  ADD CONSTRAINT "FK_editions_library" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_editions_libraryId" ON "editions" ("libraryId");

CREATE TABLE "edition_external_ids" (
  "editionId" integer NOT NULL,
  "mediaId" integer NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "PK_edition_external_ids" PRIMARY KEY ("editionId", "provider", "value"),
  CONSTRAINT "FK_edition_external_ids_edition" FOREIGN KEY ("editionId", "mediaId")
    REFERENCES "editions"("id", "mediaId") ON DELETE CASCADE,
  CONSTRAINT "CK_edition_external_ids_provider" CHECK ("provider" IN ('isbn', 'asin', 'openlibrary', 'googlebooks', 'bnf')),
  CONSTRAINT "CK_edition_external_ids_value" CHECK (
    ("provider" <> 'isbn' OR "value" ~ '^97[89][0-9]{10}$')
    AND ("provider" <> 'asin' OR "value" ~ '^[0-9A-Z]{10}$')
    AND ("provider" <> 'openlibrary' OR "value" ~ '^OL[1-9][0-9]*M$')
    AND ("provider" <> 'bnf' OR "value" ~ '^cb[0-9a-z]+$')
    AND ("provider" <> 'googlebooks' OR "value" ~ '^[A-Za-z0-9_-]{1,32}$'))
);
CREATE INDEX "IDX_edition_external_ids_edition_media" ON "edition_external_ids" ("editionId", "mediaId");
CREATE INDEX "IDX_edition_external_ids_lookup" ON "edition_external_ids" ("provider", "value");

CREATE TABLE "edition_field_sources" (
  "editionId" integer NOT NULL,
  "field" text NOT NULL,
  "provider" text,
  "locked" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_edition_field_sources" PRIMARY KEY ("editionId", "field"),
  CONSTRAINT "FK_edition_field_sources_edition" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE
);

-- Edition release dates: a work-level date has a NULL "editionId"
ALTER TABLE "media_release_dates" ADD COLUMN "editionId" integer,
  DROP CONSTRAINT "PK_media_release_dates",
  ADD CONSTRAINT "UQ_media_release_dates" UNIQUE NULLS NOT DISTINCT ("mediaId", "editionId", "kind"),
  ADD CONSTRAINT "FK_media_release_dates_edition" FOREIGN KEY ("editionId", "mediaId")
    REFERENCES "editions"("id", "mediaId") ON DELETE CASCADE;
CREATE INDEX "IDX_media_release_dates_edition_media" ON "media_release_dates" ("editionId", "mediaId");

-- Work and person ids
ALTER TABLE "media_external_ids" DROP CONSTRAINT "CK_media_external_ids_provider",
  ADD CONSTRAINT "CK_media_external_ids_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'imdb', 'openlibrary')),
  ADD CONSTRAINT "CK_media_external_ids_openlibrary" CHECK ("provider" <> 'openlibrary' OR "value" ~ '^OL[1-9][0-9]*W$');
DROP INDEX "UQ_media_external_ids_tmdb";
CREATE UNIQUE INDEX "UQ_media_external_ids_anchor" ON "media_external_ids" ("kind", "provider", "value")
  WHERE "provider" IN ('tmdb', 'openlibrary');
ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_provider", DROP CONSTRAINT "CK_requests_externalId",
  ADD CONSTRAINT "CK_requests_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'imdb', 'openlibrary')),
  ADD CONSTRAINT "CK_requests_externalId" CHECK (
    "externalId" <> ''
    AND ("provider" NOT IN ('tmdb', 'tvdb') OR "externalId" ~ '^[1-9][0-9]{0,8}$')
    AND ("provider" <> 'openlibrary' OR "externalId" ~ '^OL[1-9][0-9]*W$'));
ALTER TABLE "person_external_ids" DROP CONSTRAINT "CK_person_external_ids_provider",
  DROP CONSTRAINT "CK_person_external_ids_value",
  ADD CONSTRAINT "CK_person_external_ids_provider" CHECK ("provider" IN ('tmdb', 'tvdb', 'openlibrary', 'asin', 'bnf')),
  ADD CONSTRAINT "CK_person_external_ids_value" CHECK (
    ("provider" NOT IN ('tmdb', 'tvdb') OR "value" ~ '^[1-9][0-9]{0,8}$')
    AND ("provider" <> 'openlibrary' OR "value" ~ '^OL[1-9][0-9]*A$')
    AND ("provider" <> 'asin' OR "value" ~ '^[0-9A-Z]{10}$')
    AND ("provider" <> 'bnf' OR "value" ~ '^[0-9]{6,12}$'));

-- Series as collections
ALTER TABLE "collection_external_ids" DROP CONSTRAINT "CK_collection_external_ids_provider",
  DROP CONSTRAINT "CK_collection_external_ids_value",
  ADD CONSTRAINT "CK_collection_external_ids_provider" CHECK ("provider" IN ('tmdb', 'asin', 'bnf')),
  ADD CONSTRAINT "CK_collection_external_ids_value" CHECK (
    ("provider" <> 'tmdb' OR "value" ~ '^[1-9][0-9]{0,8}$')
    AND ("provider" <> 'asin' OR "value" ~ '^[0-9A-Z]{10}$')
    AND ("provider" <> 'bnf' OR "value" ~ '^cb[0-9a-z]+$'));

-- Sort keys
ALTER TABLE "persons" ADD COLUMN "sortName" text;
ALTER TABLE "media" ADD COLUMN "sortCreator" text;
CREATE INDEX "IDX_media_sortCreator" ON "media" ("sortCreator");

CREATE FUNCTION media_sort_creator(media integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(p."sortName", p.name) FROM media_credits c JOIN persons p ON p.id = c."personId"
   WHERE c."mediaId" = media AND c.role = 'author' AND c."editionId" IS NULL
   ORDER BY c.position, c.id LIMIT 1 $$;

CREATE FUNCTION refresh_media_sort_creator(m integer) RETURNS void LANGUAGE sql AS $$
  UPDATE media SET "sortCreator" = media_sort_creator(m)
   WHERE id = m AND "sortCreator" IS DISTINCT FROM media_sort_creator(m) $$;

CREATE FUNCTION media_credits_sort_creator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.role = 'author' THEN PERFORM refresh_media_sort_creator(OLD."mediaId"); END IF;
  IF TG_OP <> 'DELETE' AND NEW.role = 'author' THEN PERFORM refresh_media_sort_creator(NEW."mediaId"); END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER sort_creator AFTER INSERT OR UPDATE OR DELETE ON "media_credits"
  FOR EACH ROW EXECUTE FUNCTION media_credits_sort_creator();

CREATE FUNCTION persons_sort_creator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m integer;
BEGIN
  FOR m IN SELECT DISTINCT "mediaId" FROM media_credits
            WHERE "personId" = NEW.id AND role = 'author' AND "editionId" IS NULL LOOP
    PERFORM refresh_media_sort_creator(m);
  END LOOP;
  RETURN NULL;
END $$;
CREATE TRIGGER sort_creator AFTER UPDATE OF "name", "sortName" ON "persons"
  FOR EACH ROW WHEN (OLD."name" IS DISTINCT FROM NEW."name" OR OLD."sortName" IS DISTINCT FROM NEW."sortName")
  EXECUTE FUNCTION persons_sort_creator();

-- A change of "sortCreator" alone does not bump "updatedAt"
CREATE FUNCTION media_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt"
     AND NOT (NEW."sortCreator" IS DISTINCT FROM OLD."sortCreator"
              AND to_jsonb(NEW) - 'sortCreator' = to_jsonb(OLD) - 'sortCreator') THEN
    NEW."updatedAt" = now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER set_updated_at ON "media";
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media" FOR EACH ROW EXECUTE FUNCTION media_set_updated_at();
