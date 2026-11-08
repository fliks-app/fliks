-- Kind (items.md rule 39): `album` joins the kinds. The `audio` family is already listed by every family CHECK.
ALTER TABLE "media" DROP CONSTRAINT "CK_media_type",
  ADD CONSTRAINT "CK_media_type" CHECK ("type" IN ('movie', 'series', 'book', 'comic', 'album'));
ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_mediaType",
  ADD CONSTRAINT "CK_requests_mediaType" CHECK ("mediaType" IN ('movie', 'series', 'book', 'comic', 'album'));
ALTER TABLE "user_quotas" DROP CONSTRAINT "CK_user_quotas_kind",
  ADD CONSTRAINT "CK_user_quotas_kind" CHECK ("kind" IN ('movie', 'series', 'book', 'comic', 'album'));
ALTER TABLE "cleanup_rules" DROP CONSTRAINT "CK_cleanup_rules_levels",
  ADD CONSTRAINT "CK_cleanup_rules_levels"
    CHECK (cardinality("levels") >= 1
      AND "levels" <@ ARRAY['movie', 'series', 'season', 'episode', 'book', 'comic', 'album']);

-- Ids of MusicBrainz are UUIDs: a media (release group), an edition (release), a person (artist), a request
ALTER TABLE "media_external_ids"
  ADD CONSTRAINT "CK_media_external_ids_musicbrainz" CHECK (
    "provider" <> 'musicbrainz' OR "value" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
DROP INDEX "UQ_media_external_ids_anchor";
CREATE UNIQUE INDEX "UQ_media_external_ids_anchor" ON "media_external_ids" ("kind", "provider", "value")
  WHERE "provider" IN ('tmdb', 'openlibrary', 'musicbrainz');
ALTER TABLE "edition_external_ids" DROP CONSTRAINT "CK_edition_external_ids_value",
  ADD CONSTRAINT "CK_edition_external_ids_value" CHECK (
    ("provider" <> 'isbn' OR "value" ~ '^97[89][0-9]{10}$')
    AND ("provider" <> 'asin' OR "value" ~ '^[0-9A-Z]{10}$')
    AND ("provider" <> 'openlibrary' OR "value" ~ '^OL[1-9][0-9]*M$')
    AND ("provider" <> 'bnf' OR "value" ~ '^cb[0-9a-z]+$')
    AND ("provider" <> 'googlebooks' OR "value" ~ '^[A-Za-z0-9_-]{1,32}$')
    AND ("provider" <> 'musicbrainz' OR "value" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
ALTER TABLE "person_external_ids" DROP CONSTRAINT "CK_person_external_ids_value",
  ADD CONSTRAINT "CK_person_external_ids_value" CHECK (
    ("provider" NOT IN ('tmdb', 'tvdb') OR "value" ~ '^[1-9][0-9]{0,8}$')
    AND ("provider" <> 'openlibrary' OR "value" ~ '^OL[1-9][0-9]*A$')
    AND ("provider" <> 'asin' OR "value" ~ '^[0-9A-Z]{10}$')
    AND ("provider" <> 'bnf' OR "value" ~ '^[0-9]{6,12}$')
    AND ("provider" <> 'musicbrainz' OR "value" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_externalId",
  ADD CONSTRAINT "CK_requests_externalId" CHECK (
    "externalId" <> ''
    AND ("provider" NOT IN ('tmdb', 'tvdb') OR "externalId" ~ '^[1-9][0-9]{0,8}$')
    AND ("provider" <> 'openlibrary' OR "externalId" ~ '^OL[1-9][0-9]*W$')
    AND ("provider" <> 'musicbrainz'
      OR "externalId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

-- A merged MusicBrainz id is followed through its redirect: the old id keeps naming the row it was merged into
CREATE TABLE "media_external_id_aliases" (
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_media_external_id_aliases" PRIMARY KEY ("kind", "provider", "value"),
  CONSTRAINT "FK_media_external_id_aliases_media" FOREIGN KEY ("mediaId", "kind")
    REFERENCES "media"("id", "type") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IDX_media_external_id_aliases_media_kind" ON "media_external_id_aliases" ("mediaId", "kind");
CREATE TABLE "person_external_id_aliases" (
  "personId" integer NOT NULL,
  "provider" text NOT NULL,
  "value" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_person_external_id_aliases" PRIMARY KEY ("provider", "value"),
  CONSTRAINT "FK_person_external_id_aliases_person" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE
);
CREATE INDEX "IDX_person_external_id_aliases_person" ON "person_external_id_aliases" ("personId");

-- Credits: an album artist is a media credit of role `artist`; an artist follows like an author
ALTER TABLE "media_credits" DROP CONSTRAINT "CK_media_credits_role",
  ADD CONSTRAINT "CK_media_credits_role" CHECK ("role" IN ('cast', 'crew', 'author', 'narrator', 'translator', 'artist'));
ALTER TABLE "person_follows" DROP CONSTRAINT "CK_person_follows_role",
  ADD CONSTRAINT "CK_person_follows_role" CHECK ("role" IN ('author', 'artist'));

-- Release-group-level detail row (media-details.md rule 12: one details table per kind)
CREATE TABLE "album_details" (
  "id" integer NOT NULL DEFAULT nextval('media_details_id_seq'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'album',
  "primaryType" text CONSTRAINT "CK_album_details_primaryType"
    CHECK ("primaryType" IN ('album', 'single', 'ep', 'broadcast', 'other')),
  "secondaryTypes" text[] NOT NULL DEFAULT '{}' CONSTRAINT "CK_album_details_secondaryTypes"
    CHECK ("secondaryTypes" <@ ARRAY['compilation', 'soundtrack', 'spokenword', 'interview', 'audiobook',
      'audio drama', 'live', 'remix', 'dj-mix', 'mixtape/street', 'demo', 'field recording']),
  "firstReleaseDate" date,
  "isCompilation" boolean NOT NULL DEFAULT false,
  "targetEditionId" integer,
  "popularity" double precision CONSTRAINT "CK_album_details_popularity" CHECK ("popularity" >= 0),
  "originalLanguage" text,
  "orphanedAt" timestamptz,
  CONSTRAINT "PK_album_details" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_album_details_media" UNIQUE ("mediaId"),
  CONSTRAINT "CK_album_details_kind" CHECK ("kind" = 'album'),
  CONSTRAINT "FK_album_details_media" FOREIGN KEY ("mediaId", "kind") REFERENCES "media"("id", "type")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FK_album_details_target" FOREIGN KEY ("targetEditionId", "mediaId") REFERENCES "editions"("id", "mediaId")
    ON DELETE SET NULL ("targetEditionId")
);
CREATE INDEX "IDX_album_details_media_kind" ON "album_details" ("mediaId", "kind");
CREATE INDEX "IDX_album_details_target" ON "album_details" ("targetEditionId", "mediaId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "album_details" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

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
  UNION ALL
  SELECT jsonb_build_object('id', d.id, 'createdAt', iso_ms(d."createdAt"), 'updatedAt', iso_ms(d."updatedAt"),
    'budget', NULL, 'revenue', NULL, 'tagline', NULL, 'popularity', d.popularity,
    'voteCount', NULL, 'originalLanguage', d."originalLanguage",
    'productionCountries', NULL, 'productionCompanies', NULL,
    'videos', NULL, 'keywords', NULL)
    FROM album_details d WHERE d."mediaId" = media
  LIMIT 1
$$;

-- Edition facts of a release (an edition of an album is one pressing)
ALTER TABLE "editions"
  ADD COLUMN "country" text CONSTRAINT "CK_editions_country" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD COLUMN "status" text CONSTRAINT "CK_editions_status"
    CHECK ("status" IN ('official', 'promotion', 'bootleg', 'pseudo-release', 'withdrawn', 'expunged', 'cancelled')),
  ADD COLUMN "media" text CONSTRAINT "CK_editions_media" CHECK ("media" IN ('cd', 'vinyl', 'digital', 'cassette', 'other')),
  ADD COLUMN "barcode" text CONSTRAINT "CK_editions_barcode" CHECK ("barcode" ~ '^[0-9]{8,14}$'),
  ADD COLUMN "catalogNumber" text CONSTRAINT "CK_editions_catalogNumber" CHECK ("catalogNumber" <> ''),
  ADD COLUMN "trackCount" integer CONSTRAINT "CK_editions_trackCount" CHECK ("trackCount" >= 0),
  ADD COLUMN "discCount" integer CONSTRAINT "CK_editions_discCount" CHECK ("discCount" >= 1),
  ADD COLUMN "albumGain" real CONSTRAINT "CK_editions_albumGain" CHECK ("albumGain" BETWEEN -100 AND 100),
  ADD COLUMN "albumPeak" real CONSTRAINT "CK_editions_albumPeak" CHECK ("albumPeak" > 0),
  ADD COLUMN "orphanedAt" timestamptz;

-- Track facts of an item: a track is an ungrouped item of its release (items.md rule 4), `items."number"` stays NULL
-- and the disc lives here, so a disc is never an episode group
CREATE TABLE "track_details" (
  "itemId" integer NOT NULL,
  "mediaId" integer NOT NULL,
  "discNumber" integer NOT NULL DEFAULT 1 CONSTRAINT "CK_track_details_disc" CHECK ("discNumber" BETWEEN 1 AND 999),
  "discTitle" text CONSTRAINT "CK_track_details_discTitle" CHECK ("discTitle" <> ''),
  "position" integer NOT NULL CONSTRAINT "CK_track_details_position" CHECK ("position" >= 1),
  "trackNumber" integer CONSTRAINT "CK_track_details_number" CHECK ("trackNumber" BETWEEN 0 AND 9999),
  "label" text CONSTRAINT "CK_track_details_label" CHECK ("label" <> ''),
  "recordingMbid" uuid,
  "releaseTrackMbid" uuid,
  "isrc" text CONSTRAINT "CK_track_details_isrc" CHECK ("isrc" ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  "durationMs" integer CONSTRAINT "CK_track_details_duration" CHECK ("durationMs" > 0),
  "explicit" boolean NOT NULL DEFAULT false,
  "gain" real CONSTRAINT "CK_track_details_gain" CHECK ("gain" BETWEEN -100 AND 100),
  "peak" real CONSTRAINT "CK_track_details_peak" CHECK ("peak" > 0),
  "popularity" double precision CONSTRAINT "CK_track_details_popularity" CHECK ("popularity" >= 0),
  "orphanedAt" timestamptz,
  CONSTRAINT "PK_track_details" PRIMARY KEY ("itemId"),
  CONSTRAINT "FK_track_details_item" FOREIGN KEY ("itemId", "mediaId") REFERENCES "items"("id", "mediaId") ON DELETE CASCADE
);
CREATE INDEX "IDX_track_details_item_media" ON "track_details" ("itemId", "mediaId");
CREATE INDEX "IDX_track_details_media" ON "track_details" ("mediaId");
CREATE INDEX "IDX_track_details_recording" ON "track_details" ("recordingMbid") WHERE "recordingMbid" IS NOT NULL;
CREATE INDEX "IDX_track_details_isrc" ON "track_details" ("isrc") WHERE "isrc" IS NOT NULL;

-- Who made a track: several artists, composers and, for classical music, conductors and orchestras. The credited
-- name is the text printed on the release; it may differ from the person's name.
CREATE TABLE "item_credits" (
  "id" serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "itemId" integer NOT NULL,
  "personId" integer NOT NULL,
  "role" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "creditedName" text,
  "joinPhrase" text,
  "instrument" text,
  CONSTRAINT "FK_item_credits_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_item_credits_person" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE CASCADE,
  CONSTRAINT "UQ_item_credits_position" UNIQUE ("itemId", "role", "position"),
  CONSTRAINT "CK_item_credits_role"
    CHECK ("role" IN ('artist', 'composer', 'lyricist', 'performer', 'conductor', 'orchestra', 'ensemble')),
  CONSTRAINT "CK_item_credits_position" CHECK ("position" >= 0),
  CONSTRAINT "CK_item_credits_creditedName" CHECK ("creditedName" <> ''),
  CONSTRAINT "CK_item_credits_instrument" CHECK ("instrument" <> '' AND ("instrument" IS NULL OR "role" = 'performer'))
);
CREATE INDEX "IDX_item_credits_person" ON "item_credits" ("personId", "role");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "item_credits" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Classical music: a work, a movement being a work with a parent, and the works a track plays
CREATE TABLE "works" (
  "id" serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mbid" uuid,
  "title" text NOT NULL,
  "parentWorkId" integer,
  "composerPersonId" integer,
  CONSTRAINT "UQ_works_mbid" UNIQUE ("mbid"),
  CONSTRAINT "FK_works_parent" FOREIGN KEY ("parentWorkId") REFERENCES "works"("id") ON DELETE SET NULL,
  CONSTRAINT "FK_works_composer" FOREIGN KEY ("composerPersonId") REFERENCES "persons"("id") ON DELETE SET NULL,
  CONSTRAINT "CK_works_title" CHECK ("title" <> ''),
  CONSTRAINT "CK_works_parent" CHECK ("parentWorkId" IS DISTINCT FROM "id")
);
CREATE INDEX "IDX_works_parent" ON "works" ("parentWorkId");
CREATE INDEX "IDX_works_composer" ON "works" ("composerPersonId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "works" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TABLE "item_works" (
  "itemId" integer NOT NULL,
  "workId" integer NOT NULL,
  "position" integer NOT NULL DEFAULT 0 CONSTRAINT "CK_item_works_position" CHECK ("position" >= 0),
  CONSTRAINT "PK_item_works" PRIMARY KEY ("itemId", "workId"),
  CONSTRAINT "FK_item_works_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_item_works_work" FOREIGN KEY ("workId") REFERENCES "works"("id") ON DELETE CASCADE
);
CREATE INDEX "IDX_item_works_work" ON "item_works" ("workId");

-- A user's star rating of an item (no row = unrated); favourites are the item-level `likes`
CREATE TABLE "item_ratings" (
  "userId" integer NOT NULL,
  "itemId" integer NOT NULL,
  "rating" smallint NOT NULL CONSTRAINT "CK_item_ratings_rating" CHECK ("rating" BETWEEN 1 AND 5),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_item_ratings" PRIMARY KEY ("userId", "itemId"),
  CONSTRAINT "FK_item_ratings_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_item_ratings_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE
);
CREATE INDEX "IDX_item_ratings_item" ON "item_ratings" ("itemId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "item_ratings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
