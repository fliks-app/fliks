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

-- Ids of MusicBrainz are UUIDs: a media (release), a person (artist), a request
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
    AND ("provider" <> 'googlebooks' OR "value" ~ '^[A-Za-z0-9_-]{1,32}$'));
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

-- Detail row of the album's release group (media-details.md rule 12: one details table per kind)
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
  "releaseGroupMbid" uuid,
  "popularity" double precision CONSTRAINT "CK_album_details_popularity" CHECK ("popularity" >= 0),
  "originalLanguage" text,
  "orphanedAt" timestamptz,
  CONSTRAINT "PK_album_details" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_album_details_media" UNIQUE ("mediaId"),
  CONSTRAINT "CK_album_details_kind" CHECK ("kind" = 'album'),
  CONSTRAINT "FK_album_details_media" FOREIGN KEY ("mediaId", "kind") REFERENCES "media"("id", "type")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "IDX_album_details_media_kind" ON "album_details" ("mediaId", "kind");
CREATE INDEX "IDX_album_details_group" ON "album_details" ("releaseGroupMbid") WHERE "releaseGroupMbid" IS NOT NULL;
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

-- Edition facts of a release (the one hidden edition of an album is its pressing)
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
  ADD COLUMN "disambiguation" text CONSTRAINT "CK_editions_disambiguation" CHECK ("disambiguation" <> '');

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

-- The file a track plays: its own part's, else the one of a track of another album of the same library for the
-- same recording (the ISRC only when either track holds no recording id): one file serves every release.
CREATE FUNCTION track_file(item integer) RETURNS integer LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    (SELECT p."mediaFileId" FROM item_parts p WHERE p."itemId" = item ORDER BY p.version DESC, p.position LIMIT 1),
    (SELECT p."mediaFileId" FROM track_details me JOIN media mm ON mm.id = me."mediaId"
       JOIN track_details o ON o."recordingMbid" = me."recordingMbid" AND o."mediaId" <> me."mediaId"
       JOIN media om ON om.id = o."mediaId" AND om."libraryId" IS NOT DISTINCT FROM mm."libraryId"
       JOIN item_parts p ON p."itemId" = o."itemId"
      WHERE me."itemId" = item
      ORDER BY om.id, o."itemId", p.version DESC, p.position LIMIT 1),
    (SELECT p."mediaFileId" FROM track_details me JOIN media mm ON mm.id = me."mediaId"
       JOIN track_details o ON o.isrc = me.isrc AND o."mediaId" <> me."mediaId"
         AND (o."recordingMbid" IS NULL OR me."recordingMbid" IS NULL)
       JOIN media om ON om.id = o."mediaId" AND om."libraryId" IS NOT DISTINCT FROM mm."libraryId"
       JOIN item_parts p ON p."itemId" = o."itemId"
      WHERE me."itemId" = item
      ORDER BY om.id, o."itemId", p.version DESC, p.position LIMIT 1))
$$;

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

-- What a music provider says of an artist beside its name: how to file and tell it apart
ALTER TABLE "persons"
  ADD COLUMN "disambiguation" text CONSTRAINT "CK_persons_disambiguation" CHECK ("disambiguation" <> ''),
  ADD COLUMN "artistType" text CONSTRAINT "CK_persons_artistType"
    CHECK ("artistType" IN ('person', 'group', 'orchestra', 'choir', 'character', 'other'));

-- The search reads the sort name too ("Beatles, The")
CREATE OR REPLACE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.name || ' ' || COALESCE(NEW."sortName", ''));
  RETURN NEW;
END $$;
DROP TRIGGER persons_search_vector ON persons;
CREATE TRIGGER persons_search_vector BEFORE INSERT OR UPDATE OF name, "sortName"
  ON persons FOR EACH ROW EXECUTE FUNCTION persons_search_vector_update();
ALTER TABLE persons DISABLE TRIGGER set_updated_at;
UPDATE persons SET "searchVector" = to_tsvector('simple', name || ' ' || COALESCE("sortName", ''))
 WHERE "sortName" IS NOT NULL;
ALTER TABLE persons ENABLE TRIGGER set_updated_at;

-- Works are searched by title
ALTER TABLE "works" ADD COLUMN "searchVector" tsvector;
CREATE FUNCTION works_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.title);
  RETURN NEW;
END $$;
CREATE TRIGGER works_search_vector BEFORE INSERT OR UPDATE OF title
  ON works FOR EACH ROW EXECUTE FUNCTION works_search_vector_update();
CREATE INDEX "IDX_works_search_vector" ON "works" USING gin ("searchVector");

-- Which release groups and releases a library of albums wants (NULL: the default profile, `music.md` rule 44)
ALTER TABLE "libraries"
  ADD COLUMN "metadataProfile" jsonb CONSTRAINT "CK_libraries_metadataProfile"
    CHECK ("metadataProfile" IS NULL OR jsonb_typeof("metadataProfile") = 'object');

-- MP3-320 and MP3-V0 (ids 116, 117) were part of the MP3-256k bucket: an audio profile that allowed it allows both
ALTER TABLE "quality_profiles" DISABLE TRIGGER set_updated_at;
UPDATE "quality_profiles" p SET "items" = p."items" || (
  SELECT jsonb_agg(jsonb_set(jsonb_set(src.e, '{quality,id}', to_jsonb(n.id)), '{quality,name}', to_jsonb(n.name)))
  FROM (SELECT t.e FROM jsonb_array_elements(p."items") AS t(e)
         WHERE (t.e->'quality'->>'id')::int = 104 AND (t.e->>'allowed')::boolean LIMIT 1) src,
       (VALUES (116, 'MP3-320'), (117, 'MP3-V0')) AS n(id, name))
WHERE p."family" = 'audio'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."items") e
               WHERE (e->'quality'->>'id')::int = 104 AND (e->>'allowed')::boolean)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p."items") e WHERE (e->'quality'->>'id')::int = 116);
ALTER TABLE "quality_profiles" ENABLE TRIGGER set_updated_at;

-- The two rows reach a database whose audio definitions were seeded already (a fresh one seeds all of them)
INSERT INTO "quality_definitions" ("family", "qualityId", "title", "minSize", "preferredSize", "maxSize")
SELECT 'audio', v.id, v.title, v.min, v.preferred, v.max
FROM (VALUES (116, 'MP3-320', 80.0, 150.0, 320.0), (117, 'MP3-V0', 60.0, 130.0, 270.0)) AS v(id, title, min, preferred, max)
WHERE EXISTS (SELECT 1 FROM "quality_definitions" WHERE "family" = 'audio')
ON CONFLICT ("family", "qualityId") DO NOTHING;

-- A Subsonic client authenticates with token and salt, which needs the cleartext password: a `subsonic` row keeps it encrypted
ALTER TYPE "device_token_kind" ADD VALUE IF NOT EXISTS 'subsonic';
ALTER TABLE "device_tokens" ADD COLUMN "secret" bytea,
  ADD CONSTRAINT "CK_device_tokens_secret" CHECK ("secret" IS NULL OR "kind"::text = 'subsonic');

-- A smart playlist keeps its rules instead of rows: NULL is a static playlist (playlists.md rule 50)
ALTER TABLE "playlists"
  ADD COLUMN "rules" jsonb CONSTRAINT "CK_playlists_rules" CHECK (jsonb_typeof("rules") = 'object');

-- The plugin that created a playlist: `playlist.sync` writes only the playlists it created (plugins.md rule 62)
ALTER TABLE "playlists" ADD COLUMN "pluginId" varchar(255);
CREATE UNIQUE INDEX "UQ_playlists_plugin_owner_name" ON "playlists" ("ownerId", "pluginId", "name")
  WHERE "pluginId" IS NOT NULL;

-- Lyrics belong to the track item; the file only stamps the audio they were found in or timed on (music.md rule 61)
CREATE TABLE "lyrics" (
  "id" serial NOT NULL,
  "itemId" integer NOT NULL,
  "mediaFileId" integer,
  "kind" text NOT NULL DEFAULT 'main' CONSTRAINT "CK_lyrics_kind" CHECK ("kind" IN ('main', 'translation', 'pronunciation')),
  "lang" text NOT NULL DEFAULT 'und' CONSTRAINT "CK_lyrics_lang" CHECK ("lang" ~ '^[a-z0-9]{1,8}$'),
  "sync" text NOT NULL CONSTRAINT "CK_lyrics_sync" CHECK ("sync" IN ('none', 'line', 'word')),
  "source" text NOT NULL CONSTRAINT "CK_lyrics_source" CHECK (
    length("source") <= 93
    AND "source" ~ '^(embedded|sidecar|user|generated|provider:([a-z][a-z0-9]{1,31}|[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}))$'),
  "sourceRef" text,
  "offsetMs" integer NOT NULL DEFAULT 0 CONSTRAINT "CK_lyrics_offset" CHECK ("offsetMs" BETWEEN -60000 AND 60000),
  "audioDurationMs" integer,
  "doc" jsonb NOT NULL CONSTRAINT "CK_lyrics_doc" CHECK (jsonb_typeof("doc") = 'object'),
  "raw" text,
  "reviewed" boolean NOT NULL DEFAULT false,
  "preferred" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_lyrics" PRIMARY KEY ("id"),
  CONSTRAINT "FK_lyrics_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_lyrics_media_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "UQ_lyrics_item_layer" ON "lyrics" ("itemId", "kind", "lang", "source");
CREATE INDEX "IDX_lyrics_media_file" ON "lyrics" ("mediaFileId");
-- One preferred row per layer
CREATE UNIQUE INDEX "UQ_lyrics_preferred" ON "lyrics" ("itemId", "kind", "lang") WHERE "preferred";
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "lyrics" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a provider answered for a track, so a miss is not asked again at once (music.md rule 68)
CREATE TABLE "lyrics_lookups" (
  "itemId" integer NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL CONSTRAINT "CK_lyrics_lookups_status" CHECK ("status" IN ('found', 'miss', 'instrumental')),
  "checkedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_lyrics_lookups" PRIMARY KEY ("itemId", "provider"),
  CONSTRAINT "FK_lyrics_lookups_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE
);

-- An album request scoped to some tracks: their MusicBrainz recording ids and the size of the release.
-- An album request carries its wants as a book request does.
ALTER TABLE "requests" ADD COLUMN "recordings" text[], ADD COLUMN "trackCount" integer,
  DROP CONSTRAINT "CK_requests_wants",
  ADD CONSTRAINT "CK_requests_wants" CHECK (("mediaType" IN ('book', 'album') AND kind = 'add') = ("wants" IS NOT NULL)),
  ADD CONSTRAINT "CK_requests_recordings" CHECK (
    "recordings" IS NULL OR ("mediaType" = 'album' AND kind = 'add' AND cardinality("recordings") > 0)),
  ADD CONSTRAINT "CK_requests_trackCount" CHECK ("trackCount" IS NULL OR "recordings" IS NOT NULL);

-- A credited artist with no provider id merges into the one same-named artist that has a MusicBrainz id.
CREATE TEMP TABLE "_artist_merge" ON COMMIT DROP AS
SELECT p.id AS "fromId", (array_agg(q.id))[1] AS "toId"
FROM persons p
JOIN persons q ON name_key(q.name) = name_key(p.name) AND q.id <> p.id
 AND EXISTS (SELECT 1 FROM person_external_ids x WHERE x."personId" = q.id AND x.provider = 'musicbrainz')
WHERE (EXISTS (SELECT 1 FROM media_credits c WHERE c."personId" = p.id)
       OR EXISTS (SELECT 1 FROM item_credits c WHERE c."personId" = p.id))
  AND NOT EXISTS (SELECT 1 FROM person_external_ids x WHERE x."personId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM person_external_id_aliases x WHERE x."personId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                   WHERE c."personId" = p.id AND m.type <> 'album')
  AND NOT EXISTS (SELECT 1 FROM item_credits c JOIN items i ON i.id = c."itemId" JOIN media m ON m.id = i."mediaId"
                   WHERE c."personId" = p.id AND m.type <> 'album')
GROUP BY p.id
HAVING count(*) = 1;

ALTER TABLE item_credits DISABLE TRIGGER set_updated_at;
ALTER TABLE media_credits DISABLE TRIGGER set_updated_at;
ALTER TABLE person_follows DISABLE TRIGGER set_updated_at;
ALTER TABLE works DISABLE TRIGGER set_updated_at;

DELETE FROM item_credits c USING "_artist_merge" m
WHERE c."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM item_credits d WHERE d."personId" = m."toId" AND d."itemId" = c."itemId" AND d.role = c.role);
UPDATE item_credits c SET "personId" = m."toId" FROM "_artist_merge" m WHERE c."personId" = m."fromId";

DELETE FROM media_credits c USING "_artist_merge" m
WHERE c."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM media_credits d WHERE d."personId" = m."toId" AND d."mediaId" = c."mediaId"
                AND d."editionId" IS NOT DISTINCT FROM c."editionId" AND d.role = c.role);
UPDATE media_credits c SET "personId" = m."toId" FROM "_artist_merge" m WHERE c."personId" = m."fromId";

DELETE FROM person_follows f USING "_artist_merge" m
WHERE f."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM person_follows d WHERE d."personId" = m."toId" AND d."userId" = f."userId" AND d.role = f.role);
UPDATE person_follows f SET "personId" = m."toId" FROM "_artist_merge" m WHERE f."personId" = m."fromId";

UPDATE works w SET "composerPersonId" = m."toId" FROM "_artist_merge" m WHERE w."composerPersonId" = m."fromId";

ALTER TABLE item_credits ENABLE TRIGGER set_updated_at;
ALTER TABLE media_credits ENABLE TRIGGER set_updated_at;
ALTER TABLE person_follows ENABLE TRIGGER set_updated_at;
ALTER TABLE works ENABLE TRIGGER set_updated_at;

DELETE FROM persons WHERE id IN (SELECT "fromId" FROM "_artist_merge");
