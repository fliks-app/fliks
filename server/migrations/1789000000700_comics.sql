-- Kind and families (items.md rule 39): `comic` joins the kinds, `image` the families some kind is wished in
ALTER TABLE "media" DROP CONSTRAINT "CK_media_type",
  ADD CONSTRAINT "CK_media_type" CHECK ("type" IN ('movie', 'series', 'book', 'comic'));
ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_mediaType",
  ADD CONSTRAINT "CK_requests_mediaType" CHECK ("mediaType" IN ('movie', 'series', 'book', 'comic'));
ALTER TABLE "user_quotas" DROP CONSTRAINT "CK_user_quotas_kind",
  ADD CONSTRAINT "CK_user_quotas_kind" CHECK ("kind" IN ('movie', 'series', 'book', 'comic'));
ALTER TABLE "cleanup_rules" DROP CONSTRAINT "CK_cleanup_rules_levels",
  ADD CONSTRAINT "CK_cleanup_rules_levels"
    CHECK (cardinality("levels") >= 1 AND "levels" <@ ARRAY['movie', 'series', 'season', 'episode', 'book', 'comic']);
ALTER TABLE "editions" DROP CONSTRAINT "CK_editions_family",
  ADD CONSTRAINT "CK_editions_family" CHECK ("family" IN ('video', 'audio', 'text', 'image'));
ALTER TABLE "wants" DROP CONSTRAINT "CK_wants_family",
  ADD CONSTRAINT "CK_wants_family" CHECK ("family" IN ('video', 'audio', 'text', 'image'));
ALTER TABLE "quality_profiles" DROP CONSTRAINT "CK_quality_profiles_family",
  ADD CONSTRAINT "CK_quality_profiles_family" CHECK ("family" IN ('video', 'audio', 'text', 'image'));
ALTER TABLE "quality_definitions" DROP CONSTRAINT "CK_quality_definitions_family",
  ADD CONSTRAINT "CK_quality_definitions_family" CHECK ("family" IN ('video', 'audio', 'text', 'image'));

-- Volume-level detail row (media-details.md rule 12: one details table per kind)
CREATE TABLE "comic_details" (
  "id" integer NOT NULL DEFAULT nextval('media_details_id_seq'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'comic',
  "publisher" text,
  "startYear" integer CONSTRAINT "CK_comic_details_startYear" CHECK ("startYear" BETWEEN 1 AND 9999),
  "volume" integer CONSTRAINT "CK_comic_details_volume" CHECK ("volume" >= 0),
  "originalLanguage" text,
  CONSTRAINT "PK_comic_details" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_comic_details_media" UNIQUE ("mediaId"),
  CONSTRAINT "CK_comic_details_kind" CHECK ("kind" = 'comic'),
  CONSTRAINT "FK_comic_details_media" FOREIGN KEY ("mediaId", "kind") REFERENCES "media"("id", "type")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IDX_comic_details_media_kind" ON "comic_details" ("mediaId", "kind");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "comic_details" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
  UNION ALL
  SELECT jsonb_build_object('id', d.id, 'createdAt', iso_ms(d."createdAt"), 'updatedAt', iso_ms(d."updatedAt"),
    'budget', NULL, 'revenue', NULL, 'tagline', NULL, 'popularity', NULL,
    'voteCount', NULL, 'originalLanguage', d."originalLanguage",
    'productionCountries', NULL, 'productionCompanies', NULL,
    'videos', NULL, 'keywords', NULL)
    FROM comic_details d WHERE d."mediaId" = media
  LIMIT 1
$$;

-- Issue facts of an item: items."number" stays NULL for comics (it is an integer the series paths read), so the
-- decimal sort key, the printed label and the kind of issue live here
CREATE TABLE "comic_issues" (
  "itemId" integer NOT NULL,
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'issue' CONSTRAINT "CK_comic_issues_kind" CHECK ("kind" IN ('issue', 'annual', 'special')),
  "sortNumber" numeric NOT NULL CONSTRAINT "CK_comic_issues_sort" CHECK ("sortNumber" NOT IN ('NaN', 'Infinity', '-Infinity')),
  "label" text NOT NULL CONSTRAINT "CK_comic_issues_label" CHECK ("label" <> ''),
  "pageCount" integer CONSTRAINT "CK_comic_issues_pageCount" CHECK ("pageCount" > 0),
  CONSTRAINT "PK_comic_issues" PRIMARY KEY ("itemId"),
  CONSTRAINT "UQ_comic_issues_number" UNIQUE ("mediaId", "kind", "sortNumber"),
  CONSTRAINT "FK_comic_issues_item" FOREIGN KEY ("itemId", "mediaId") REFERENCES "items"("id", "mediaId") ON DELETE CASCADE
);
CREATE INDEX "IDX_comic_issues_item_media" ON "comic_issues" ("itemId", "mediaId");
