-- A plugin foreign key into `public` runs core deletes' cascades and triggers as the core login.
DO $$
DECLARE r record;
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  FOR r IN
    SELECT con.conname, con.conrelid::regclass AS rel
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class fcl ON fcl.oid = con.confrelid
      JOIN pg_namespace fns ON fns.oid = fcl.relnamespace
     WHERE con.contype = 'f' AND con.conparentid = 0 AND ns.nspname LIKE 'plugin\_%' AND fns.nspname = 'public'
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.rel, r.conname);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'could not drop % on %: %', r.conname, r.rel, SQLERRM;
    END;
  END LOOP;
END $$;

-- Users following an in-flight request they did not make: they hear when it is decided or available.
CREATE TABLE "request_watchers" (
  "requestId" integer NOT NULL REFERENCES "requests" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_request_watchers" PRIMARY KEY ("requestId", "userId")
);
CREATE INDEX "IDX_request_watchers_user" ON "request_watchers" ("userId");

-- The playback state's `updatedAt` right after KOReader's own last write: a later one is a write it has not seen.
ALTER TABLE "kosync_progress" ADD COLUMN "stateAt" timestamptz;

-- KOReader's last write still standing in the state: the same progression, so it has seen it.
UPDATE "kosync_progress" kp SET "stateAt" = ps."updatedAt"
  FROM "item_parts" p
  JOIN "playback_states" ps ON ps."itemId" = p."itemId"
 WHERE p."mediaFileId" = kp."mediaFileId" AND ps."userId" = kp."userId"
   AND ps."progression" = LEAST(GREATEST(kp."percentage", 0), 1);

-- First run: a default quality profile per family that has none, English name for the seeded language profile.
INSERT INTO "quality_profiles" ("name", "family", "cutoff", "items", "createdAt", "updatedAt")
SELECT 'Default', 'video', 16, '[{"quality":{"id":1,"name":"WORKPRINT","resolution":0,"source":"workprint"},"allowed":false,"sortOrder":0},{"quality":{"id":2,"name":"CAM","resolution":0,"source":"cam"},"allowed":false,"sortOrder":1},{"quality":{"id":3,"name":"TELESYNC","resolution":0,"source":"telesync"},"allowed":false,"sortOrder":2},{"quality":{"id":4,"name":"TELECINE","resolution":0,"source":"telecine"},"allowed":false,"sortOrder":3},{"quality":{"id":5,"name":"DVD","resolution":480,"source":"dvd"},"allowed":true,"sortOrder":4},{"quality":{"id":6,"name":"DVD-R","resolution":480,"source":"dvd"},"allowed":true,"sortOrder":5},{"quality":{"id":7,"name":"SDTV","resolution":480,"source":"sdtv"},"allowed":true,"sortOrder":6},{"quality":{"id":8,"name":"WEBDL-480p","resolution":480,"source":"web"},"allowed":true,"sortOrder":7},{"quality":{"id":9,"name":"WEBRip-480p","resolution":480,"source":"web"},"allowed":true,"sortOrder":8},{"quality":{"id":10,"name":"Bluray-480p","resolution":480,"source":"bluray"},"allowed":true,"sortOrder":9},{"quality":{"id":11,"name":"HDTV-720p","resolution":720,"source":"hdtv"},"allowed":true,"sortOrder":10},{"quality":{"id":12,"name":"WEBDL-720p","resolution":720,"source":"web"},"allowed":true,"sortOrder":11},{"quality":{"id":13,"name":"WEBRip-720p","resolution":720,"source":"web"},"allowed":true,"sortOrder":12},{"quality":{"id":14,"name":"Bluray-720p","resolution":720,"source":"bluray"},"allowed":true,"sortOrder":13},{"quality":{"id":15,"name":"HDTV-1080p","resolution":1080,"source":"hdtv"},"allowed":true,"sortOrder":14},{"quality":{"id":16,"name":"WEBDL-1080p","resolution":1080,"source":"web"},"allowed":true,"sortOrder":15},{"quality":{"id":17,"name":"WEBRip-1080p","resolution":1080,"source":"web"},"allowed":true,"sortOrder":16},{"quality":{"id":18,"name":"Bluray-1080p","resolution":1080,"source":"bluray"},"allowed":true,"sortOrder":17},{"quality":{"id":19,"name":"Remux-1080p","resolution":1080,"source":"remux"},"allowed":true,"sortOrder":18},{"quality":{"id":20,"name":"HDTV-2160p","resolution":2160,"source":"hdtv"},"allowed":true,"sortOrder":19},{"quality":{"id":21,"name":"WEBDL-2160p","resolution":2160,"source":"web"},"allowed":true,"sortOrder":20},{"quality":{"id":22,"name":"WEBRip-2160p","resolution":2160,"source":"web"},"allowed":true,"sortOrder":21},{"quality":{"id":23,"name":"Bluray-2160p","resolution":2160,"source":"bluray"},"allowed":true,"sortOrder":22},{"quality":{"id":24,"name":"Remux-2160p","resolution":2160,"source":"remux"},"allowed":true,"sortOrder":23}]'::jsonb, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "quality_profiles" WHERE "family" = 'video');

INSERT INTO "quality_profiles" ("name", "family", "cutoff", "items", "createdAt", "updatedAt")
SELECT 'Default', 'audio', 114, '[{"quality":{"id":101,"name":"Unknown-audio","resolution":0,"source":"unknown"},"allowed":false,"sortOrder":0},{"quality":{"id":102,"name":"MP3-64k","resolution":64,"source":"mp3"},"allowed":true,"sortOrder":1},{"quality":{"id":103,"name":"MP3-128k","resolution":128,"source":"mp3"},"allowed":true,"sortOrder":2},{"quality":{"id":104,"name":"MP3-256k","resolution":256,"source":"mp3"},"allowed":true,"sortOrder":3},{"quality":{"id":105,"name":"Vorbis-64k","resolution":64,"source":"vorbis"},"allowed":true,"sortOrder":4},{"quality":{"id":106,"name":"Vorbis-128k","resolution":128,"source":"vorbis"},"allowed":true,"sortOrder":5},{"quality":{"id":107,"name":"Vorbis-256k","resolution":256,"source":"vorbis"},"allowed":true,"sortOrder":6},{"quality":{"id":108,"name":"AAC-64k","resolution":64,"source":"aac"},"allowed":true,"sortOrder":7},{"quality":{"id":109,"name":"AAC-128k","resolution":128,"source":"aac"},"allowed":true,"sortOrder":8},{"quality":{"id":110,"name":"AAC-256k","resolution":256,"source":"aac"},"allowed":true,"sortOrder":9},{"quality":{"id":111,"name":"Opus-64k","resolution":64,"source":"opus"},"allowed":true,"sortOrder":10},{"quality":{"id":112,"name":"Opus-128k","resolution":128,"source":"opus"},"allowed":true,"sortOrder":11},{"quality":{"id":113,"name":"Opus-256k","resolution":256,"source":"opus"},"allowed":true,"sortOrder":12},{"quality":{"id":114,"name":"Lossless-16bit","resolution":16,"source":"lossless"},"allowed":true,"sortOrder":13},{"quality":{"id":115,"name":"Lossless-24bit","resolution":24,"source":"lossless"},"allowed":true,"sortOrder":14},{"quality":{"id":116,"name":"MP3-320","resolution":320,"source":"mp3"},"allowed":true,"sortOrder":15},{"quality":{"id":117,"name":"MP3-V0","resolution":245,"source":"mp3"},"allowed":true,"sortOrder":16}]'::jsonb, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "quality_profiles" WHERE "family" = 'audio');

INSERT INTO "quality_profiles" ("name", "family", "cutoff", "items", "createdAt", "updatedAt")
SELECT 'Default', 'text', 205, '[{"quality":{"id":201,"name":"Unknown-text","resolution":0,"source":"unknown"},"allowed":false,"sortOrder":0},{"quality":{"id":202,"name":"PDF","resolution":0,"source":"pdf"},"allowed":true,"sortOrder":1},{"quality":{"id":203,"name":"MOBI","resolution":0,"source":"mobi"},"allowed":true,"sortOrder":2},{"quality":{"id":204,"name":"AZW3","resolution":0,"source":"azw3"},"allowed":true,"sortOrder":3},{"quality":{"id":205,"name":"EPUB","resolution":0,"source":"epub"},"allowed":true,"sortOrder":4},{"quality":{"id":206,"name":"FB2","resolution":0,"source":"fb2"},"allowed":true,"sortOrder":5},{"quality":{"id":207,"name":"CBZ","resolution":0,"source":"cbz"},"allowed":true,"sortOrder":6}]'::jsonb, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "quality_profiles" WHERE "family" = 'text');

INSERT INTO "quality_profiles" ("name", "family", "cutoff", "items", "createdAt", "updatedAt")
SELECT 'Default', 'image', 302, '[{"quality":{"id":301,"name":"Unknown-image","resolution":0,"source":"unknown"},"allowed":false,"sortOrder":0},{"quality":{"id":302,"name":"CBZ","resolution":0,"source":"cbz"},"allowed":true,"sortOrder":1},{"quality":{"id":303,"name":"CBR","resolution":0,"source":"cbr"},"allowed":true,"sortOrder":2},{"quality":{"id":304,"name":"CB7","resolution":0,"source":"cb7"},"allowed":true,"sortOrder":3},{"quality":{"id":305,"name":"PDF","resolution":0,"source":"pdf"},"allowed":true,"sortOrder":4}]'::jsonb, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "quality_profiles" WHERE "family" = 'image');

ALTER TABLE "language_profiles" DISABLE TRIGGER set_updated_at;
UPDATE "language_profiles" SET "name" = 'All languages'
 WHERE "name" = 'Toutes les langues (défaut)' AND "audioLanguages" = '[]' AND "subtitleLanguages" = '[]';
ALTER TABLE "language_profiles" ENABLE TRIGGER set_updated_at;

-- Media issues, reported by users or raised by the health checks (no reporter).
CREATE TABLE "media_issues" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "userId" integer REFERENCES "users"("id") ON DELETE CASCADE,
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "itemId" integer REFERENCES "items"("id") ON DELETE SET NULL,
  "seasonNumber" integer,
  "episodeNumber" integer,
  "mediaFileId" integer REFERENCES "media_files"("id") ON DELETE SET NULL,
  "fileSize" bigint,
  "issueKind" text NOT NULL CHECK ("issueKind" IN ('video', 'audio', 'subtitles', 'playback', 'other')),
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'acknowledged', 'resolved', 'closed')),
  "autoResolved" boolean NOT NULL DEFAULT false,
  "resolvedById" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "resolvedAt" timestamptz,
  "source" text NOT NULL DEFAULT 'user' CHECK ("source" IN ('user', 'health')),
  CONSTRAINT "CHK_media_issues_reporter" CHECK ("source" = 'health' OR "userId" IS NOT NULL)
);
CREATE INDEX "IDX_media_issues_media_status" ON "media_issues" ("mediaId", "status");
CREATE INDEX "IDX_media_issues_user" ON "media_issues" ("userId");
CREATE INDEX "IDX_media_issues_item" ON "media_issues" ("itemId");
CREATE INDEX "IDX_media_issues_file" ON "media_issues" ("mediaFileId");
CREATE INDEX "IDX_media_issues_resolved_by" ON "media_issues" ("resolvedById");

CREATE TABLE "media_issue_comments" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "issueId" integer NOT NULL REFERENCES "media_issues"("id") ON DELETE CASCADE,
  "userId" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "message" text NOT NULL
);
CREATE INDEX "IDX_media_issue_comments_issue" ON "media_issue_comments" ("issueId");
CREATE INDEX "IDX_media_issue_comments_user" ON "media_issue_comments" ("userId");

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_issues" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_issue_comments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The home calendar filters episodes and comic issues by air date.
CREATE INDEX "IDX_items_airDate" ON items ("airDate") WHERE "airDate" IS NOT NULL;

-- Delivery state of a notification connection.
ALTER TABLE "notification_connections"
  ADD COLUMN "lastSentAt" timestamptz,
  ADD COLUMN "lastError" text,
  ADD COLUMN "lastErrorAt" timestamptz;

-- A session is live while it is not revoked and one of its refresh tokens can still be used.
CREATE FUNCTION session_is_live(p_session integer, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM sessions s JOIN refresh_tokens t ON t."sessionId" = s.id
    WHERE s.id = p_session AND s."revokedAt" IS NULL AND t."revokedAt" IS NULL AND t."expiresAt" > p_at)
$$;

-- The last search of the core acquisition sweep per media, family and language: what it found and why nothing was grabbed.
CREATE TABLE "acquisition_attempts" (
  "mediaId" integer NOT NULL REFERENCES "media" ("id") ON DELETE CASCADE,
  "family" text NOT NULL,
  "language" text NOT NULL DEFAULT '',
  "at" timestamptz NOT NULL,
  "outcome" text NOT NULL,
  "found" integer NOT NULL,
  "eligible" integer NOT NULL,
  "rejections" jsonb NOT NULL DEFAULT '[]',
  "failed" jsonb NOT NULL DEFAULT '[]',
  "nextAt" timestamptz,
  CONSTRAINT "PK_acquisition_attempts" PRIMARY KEY ("mediaId", "family", "language"),
  CONSTRAINT "CK_acquisition_attempts_outcome" CHECK ("outcome" IN ('grabbed', 'none', 'busy', 'timed_out'))
);

-- Accounts the Seerr and Emby imports created or an admin mapped: an import reuses a user only through this
-- table, never by name. `provider` is `seerr` or `emby:<server id>`.
CREATE TABLE "user_external_ids" (
  "provider" text NOT NULL,
  "externalId" text NOT NULL,
  "userId" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "PK_user_external_ids" PRIMARY KEY ("provider", "externalId")
);
CREATE INDEX "IDX_user_external_ids_user" ON "user_external_ids" ("userId");

-- Durable markers of the post-import work: a file is enriched once its crop and hash are stored,
-- a media is settled once its last settle ran past the newest file it holds.

ALTER TABLE "media_files" ADD COLUMN "enrichedAt" timestamptz;
ALTER TABLE "media" ADD COLUMN "settledAt" timestamptz;

-- Rows past the sweep window are never revisited; a recent file with a stored hash is done.
ALTER TABLE "media_files" DISABLE TRIGGER set_updated_at;
UPDATE "media_files" SET "enrichedAt" = now()
WHERE "osdbHash" IS NOT NULL OR "createdAt" <= now() - interval '7 days';
ALTER TABLE "media_files" ENABLE TRIGGER set_updated_at;

-- The one folding function of every search: unaccent is not IMMUTABLE as shipped, so an index needs this wrapper.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT public.unaccent('public.unaccent', $1) $$;

-- Titles are unstemmed and folded (any metadata language); only the overview keeps the French stemmer.
CREATE FUNCTION media_search_vector(title text, original text, alternatives jsonb, overview text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', f_unaccent(COALESCE(title, ''))), 'A') ||
    setweight(to_tsvector('simple', f_unaccent(COALESCE(original, ''))), 'B') ||
    setweight(to_tsvector('simple', f_unaccent(COALESCE(
      CASE WHEN jsonb_typeof(alternatives) = 'array'
           THEN (SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(alternatives) t) END, ''))), 'B') ||
    setweight(to_tsvector('french', f_unaccent(COALESCE(overview, ''))), 'C') $$;

CREATE OR REPLACE FUNCTION media_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := media_search_vector(NEW.title, NEW."originalTitle", NEW."alternativeTitles", NEW.overview);
  RETURN NEW;
END $$;
DROP TRIGGER media_search_vector ON media;
CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", "alternativeTitles", overview
  ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update();

CREATE OR REPLACE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', f_unaccent(NEW.name || ' ' || COALESCE(NEW."sortName", '')));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION works_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', f_unaccent(NEW.title));
  RETURN NEW;
END $$;

-- Songs match this text; it is stored folded.
CREATE OR REPLACE FUNCTION track_search_text(track_item integer, track_label text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT f_unaccent(COALESCE(i.title, track_label, '') || ' ' || m.title || ' ' || COALESCE((SELECT string_agg(p.name, ' ' ORDER BY mc.position)
      FROM media_credits mc JOIN persons p ON p.id = mc."personId" WHERE mc."mediaId" = m.id AND mc.role = 'artist'), ''))
    FROM items i JOIN media m ON m.id = i."mediaId" WHERE i.id = track_item $$;

-- The backfills must not bump every "updatedAt".
ALTER TABLE media DISABLE TRIGGER set_updated_at;
UPDATE media SET "searchVector" = media_search_vector(title, "originalTitle", "alternativeTitles", overview);
ALTER TABLE media ENABLE TRIGGER set_updated_at;

ALTER TABLE persons DISABLE TRIGGER set_updated_at;
UPDATE persons SET "searchVector" = to_tsvector('simple', f_unaccent(name || ' ' || COALESCE("sortName", '')));
ALTER TABLE persons ENABLE TRIGGER set_updated_at;

UPDATE works SET "searchVector" = to_tsvector('simple', f_unaccent(title));
UPDATE track_details SET "searchText" = track_search_text("itemId", label);

-- The trigram branches of the library search compare folded titles.
DROP INDEX "IDX_media_title_trgm";
DROP INDEX "IDX_media_originalTitle_trgm";
CREATE INDEX "IDX_media_title_trgm" ON media USING gin (f_unaccent(title) gin_trgm_ops);
CREATE INDEX "IDX_media_originalTitle_trgm" ON media USING gin (f_unaccent("originalTitle") gin_trgm_ops);

-- Programmes are stored as the feed gives them and shifted per channel at read: take the old shift back out
-- (the first enabled channel of a guide id supplied it) and read every feed again, which also applies the
-- timezone correction to every stamp.
ALTER TABLE "livetv_programs" DISABLE TRIGGER set_updated_at;
ALTER TABLE "livetv_guide_sources" DISABLE TRIGGER set_updated_at;

UPDATE "livetv_programs" p
SET "startsAt" = p."startsAt" - make_interval(mins => f.shift),
    "endsAt" = p."endsAt" - make_interval(mins => f.shift)
FROM (
  SELECT guide, shift FROM (
    SELECT DISTINCT ON ("guideChannelId") "guideChannelId" AS guide, "guideShiftMinutes" AS shift
    FROM "livetv_channels" WHERE enabled AND "guideChannelId" IS NOT NULL
    ORDER BY "guideChannelId", id
  ) first WHERE shift <> 0
) f
WHERE p."guideChannelId" = f.guide;

UPDATE "livetv_guide_sources" SET etag = NULL, "lastModified" = NULL, "lastSyncAt" = NULL;

ALTER TABLE "livetv_programs" ENABLE TRIGGER set_updated_at;
ALTER TABLE "livetv_guide_sources" ENABLE TRIGGER set_updated_at;

-- The field order of a live upstream's video is kept with its other probed facts, so a session opens with it known.
ALTER TABLE livetv_channel_streams ADD COLUMN "probedFieldOrder" character varying(16);

CREATE TABLE "health_checks" (
  "key" text PRIMARY KEY,
  "state" text NOT NULL CHECK ("state" IN ('warn', 'error')),
  "code" text NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}',
  "link" text,
  "since" timestamptz NOT NULL DEFAULT now(),
  "checkedAt" timestamptz NOT NULL DEFAULT now()
);

-- The app and version a session was last seen from (`X-Fliks-Client`), next to its user agent.
ALTER TABLE "sessions" ADD COLUMN "client" text;

-- The setup checklist reads a durable marker; instances that imported before it existed get it from the audit rows.
INSERT INTO app_settings ("key", "value")
SELECT 'data_import_done', 'true'
WHERE EXISTS (
  SELECT 1 FROM commands WHERE status = 'completed' AND name IN ('ImportWatchHistory', 'ImportSeerrRequests')
)
ON CONFLICT ("key") DO NOTHING;
