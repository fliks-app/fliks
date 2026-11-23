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

-- DATA-HYGIENE: duplicate seasons and episodes (`docs/spec/items.md` rule 6) are merged into the lowest id, then keyed.
CREATE FUNCTION pg_temp.move_rows(tbl regclass, col text, src integer, dst integer) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  BEGIN
    EXECUTE format('UPDATE %s SET %I = $1 WHERE %I = $2', tbl, col, col) USING dst, src;
  EXCEPTION WHEN unique_violation THEN
    FOR r IN EXECUTE format('SELECT ctid AS row FROM %s WHERE %I = $1', tbl, col) USING src LOOP
      BEGIN
        EXECUTE format('UPDATE %s SET %I = $1 WHERE ctid = $2 AND %I = $3', tbl, col, col) USING dst, r.row, src;
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END LOOP;
  END;
END $$;

DO $$
DECLARE
  r record; t record; tbl regclass; silenced regclass[];
  k integer; d integer; shift integer; groups integer := 0; episodes integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM item_groups GROUP BY "mediaId", "number" HAVING count(*) > 1)
     AND NOT EXISTS (SELECT 1 FROM items WHERE "groupId" IS NOT NULL GROUP BY "groupId", "number" HAVING count(*) > 1) THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT tgrelid::regclass) INTO silenced FROM pg_trigger
   WHERE tgname = 'set_updated_at'
     AND (tgrelid IN ('items'::regclass, 'item_groups'::regclass, 'acquisition_queue'::regclass)
          OR tgrelid IN (SELECT conrelid FROM pg_constraint
                          WHERE contype = 'f' AND confrelid IN ('items'::regclass, 'item_groups'::regclass)));
  FOREACH tbl IN ARRAY silenced LOOP
    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER set_updated_at', tbl);
  END LOOP;

  -- Seasons: the episodes and the rows keyed by the season move to the lowest id.
  FOR r IN SELECT array_agg(id ORDER BY id) AS ids FROM item_groups GROUP BY "mediaId", "number" HAVING count(*) > 1 LOOP
    k := r.ids[1];
    FOREACH d IN ARRAY r.ids[2:] LOOP
      UPDATE items SET "groupId" = k WHERE "groupId" = d;
      FOR t IN SELECT DISTINCT c.conrelid::regclass AS tbl, a.attname AS col
                 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
                WHERE c.contype = 'f' AND c.confrelid = 'item_groups'::regclass AND cardinality(c.conkey) = 1 LOOP
        PERFORM pg_temp.move_rows(t.tbl, t.col, d, k);
      END LOOP;
      DELETE FROM item_groups WHERE id = d;
      groups := groups + 1;
    END LOOP;
  END LOOP;

  -- Episodes: the files become versions of the lowest id, the rows keyed by the item move with it, and the
  -- furthest progress of a user stays; a row the kept item holds a twin of goes with the deleted one.
  FOR r IN SELECT array_agg(id ORDER BY id) AS ids FROM items WHERE "groupId" IS NOT NULL
            GROUP BY "groupId", "number" HAVING count(*) > 1 LOOP
    k := r.ids[1];
    FOREACH d IN ARRAY r.ids[2:] LOOP
      shift := GREATEST(
        (SELECT COALESCE(max("version") + 1, 0) FROM item_parts WHERE "itemId" = k),
        (SELECT COALESCE(max(GREATEST("version", "toVersion")) + 1, 0) FROM item_version_aliases WHERE "itemId" = k));
      DELETE FROM item_parts WHERE "itemId" = d
        AND "mediaFileId" IN (SELECT "mediaFileId" FROM item_parts WHERE "itemId" = k);
      UPDATE playback_states SET "version" = "version" + shift WHERE "itemId" = d;
      UPDATE item_version_aliases SET "version" = "version" + shift, "toVersion" = "toVersion" + shift WHERE "itemId" = d;
      -- One statement: the chapter key onto `item_parts` is checked at its end.
      WITH m AS (UPDATE item_markers SET "itemId" = k WHERE "itemId" = d AND "mediaFileId" IS NOT NULL)
      UPDATE item_parts SET "itemId" = k, "version" = "version" + shift WHERE "itemId" = d;

      UPDATE playback_states s
         SET "positionSeconds" = x."positionSeconds", "durationSeconds" = x."durationSeconds",
             "completed" = x."completed", "progression" = x."progression", "locator" = x."locator",
             "playedAt" = x."playedAt", "hiddenFromContinueWatching" = x."hiddenFromContinueWatching",
             "mediaFileId" = x."mediaFileId", "version" = x."version",
             "lastPlayedAt" = GREATEST(s."lastPlayedAt", x."lastPlayedAt")
        FROM playback_states x
       WHERE s."itemId" = k AND x."itemId" = d AND x."userId" = s."userId"
         AND (x."completed", x."positionSeconds", COALESCE(x."progression", 0))
           > (s."completed", s."positionSeconds", COALESCE(s."progression", 0));

      UPDATE acquisition_queue SET "itemIds" = array_replace("itemIds", d, k) WHERE d = ANY("itemIds");
      FOR t IN SELECT DISTINCT c.conrelid::regclass AS tbl, a.attname AS col
                 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
                WHERE c.contype = 'f' AND c.confrelid = 'items'::regclass AND a.attname = 'itemId'
                  AND c.conrelid <> 'item_parts'::regclass LOOP
        PERFORM pg_temp.move_rows(t.tbl, t.col, d, k);
      END LOOP;
      DELETE FROM items WHERE id = d;
      episodes := episodes + 1;
    END LOOP;
  END LOOP;

  FOREACH tbl IN ARRAY silenced LOOP
    EXECUTE format('ALTER TABLE %s ENABLE TRIGGER set_updated_at', tbl);
  END LOOP;
  RAISE NOTICE 'item_groups: % duplicate season(s) merged into the lowest id', groups;
  RAISE NOTICE 'items: % duplicate episode(s) merged into the lowest id, their files kept as versions', episodes;
END $$;
DROP FUNCTION pg_temp.move_rows(regclass, text, integer, integer);

ALTER TABLE "item_groups" ADD CONSTRAINT "UQ_item_groups_media_number" UNIQUE ("mediaId", "number");
ALTER TABLE "items" ADD CONSTRAINT "UQ_items_group_number" UNIQUE ("groupId", "number");
DROP INDEX "IDX_items_group_number";

-- Data hygiene: orphan rows, then foreign keys and NOT NULL, then indexes, then column types.
DELETE FROM "remote_control_grants" g
 WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = g."ownerUserId")
    OR (g."granteeUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = g."granteeUserId"));
DELETE FROM "recommendation_dismissals" d
 WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = d."userId")
    OR NOT EXISTS (SELECT 1 FROM "media" m WHERE m."id" = d."mediaId");
DELETE FROM "pairing_requests" p
 WHERE p."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = p."userId");
DELETE FROM "oidc_logins" l
 WHERE l."expectUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = l."expectUserId");
DELETE FROM "book_merges" b WHERE NOT EXISTS (SELECT 1 FROM "library_folders" f WHERE f."id" = b."folderId");

ALTER TABLE "pairing_requests" DISABLE TRIGGER set_updated_at;
UPDATE "pairing_requests" p SET "approvedByUserId" = NULL
 WHERE p."approvedByUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = p."approvedByUserId");
ALTER TABLE "pairing_requests" ENABLE TRIGGER set_updated_at;

-- Rows whose parent column was never filled are unreachable.
DELETE FROM "media_files" WHERE "mediaId" IS NULL;
DELETE FROM "subtitle_files" WHERE "mediaId" IS NULL;
DELETE FROM "library_user_access" WHERE "libraryId" IS NULL OR "userId" IS NULL;
DELETE FROM "request_comments" WHERE "requestId" IS NULL OR "userId" IS NULL;
DELETE FROM "requests" WHERE "userId" IS NULL;
DELETE FROM "livetv_channel_streams" WHERE "channelId" IS NULL OR "sourceId" IS NULL;
DELETE FROM "livetv_user_channel_prefs" WHERE "userId" IS NULL OR "channelId" IS NULL;
DELETE FROM "livetv_group_access" WHERE "userId" IS NULL;
DELETE FROM "livetv_programs" WHERE "guideSourceId" IS NULL;
DELETE FROM "livetv_guide_channels" WHERE "guideSourceId" IS NULL;

-- An OCR trash entry kept its subtitle row as the text column had it.
UPDATE "jobs" SET "result" = jsonb_set("result", '{ocrRows}', COALESCE((
    SELECT jsonb_agg(CASE WHEN jsonb_typeof(e #> '{row,tags}') = 'string' THEN jsonb_set(e, '{row,tags}', '[]') ELSE e END)
      FROM jsonb_array_elements("result" -> 'ocrRows') e), '[]'))
 WHERE CASE WHEN jsonb_typeof("result" -> 'ocrRows') = 'array' THEN EXISTS (
     SELECT 1 FROM jsonb_array_elements("result" -> 'ocrRows') e WHERE jsonb_typeof(e #> '{row,tags}') = 'string')
   ELSE false END;

ALTER TABLE "remote_control_grants"
  ADD CONSTRAINT "FK_remote_control_grants_owner" FOREIGN KEY ("ownerUserId") REFERENCES "users" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "FK_remote_control_grants_grantee" FOREIGN KEY ("granteeUserId") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "recommendation_dismissals"
  ADD CONSTRAINT "FK_recommendation_dismissals_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "FK_recommendation_dismissals_media" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE;
ALTER TABLE "pairing_requests"
  ADD CONSTRAINT "FK_pairing_requests_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
  ADD CONSTRAINT "FK_pairing_requests_approved_by" FOREIGN KEY ("approvedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL;
ALTER TABLE "oidc_logins"
  ADD CONSTRAINT "FK_oidc_logins_expect_user" FOREIGN KEY ("expectUserId") REFERENCES "users" ("id") ON DELETE CASCADE;
ALTER TABLE "book_merges"
  ADD CONSTRAINT "FK_book_merges_folder" FOREIGN KEY ("folderId") REFERENCES "library_folders" ("id") ON DELETE CASCADE;

ALTER TABLE "media_files" ALTER COLUMN "mediaId" SET NOT NULL;
ALTER TABLE "subtitle_files" ALTER COLUMN "mediaId" SET NOT NULL;
ALTER TABLE "library_user_access" ALTER COLUMN "libraryId" SET NOT NULL, ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "request_comments" ALTER COLUMN "requestId" SET NOT NULL, ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "requests" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "livetv_channel_streams" ALTER COLUMN "channelId" SET NOT NULL, ALTER COLUMN "sourceId" SET NOT NULL;
ALTER TABLE "livetv_user_channel_prefs" ALTER COLUMN "userId" SET NOT NULL, ALTER COLUMN "channelId" SET NOT NULL;
ALTER TABLE "livetv_group_access" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "livetv_programs" ALTER COLUMN "guideSourceId" SET NOT NULL;
ALTER TABLE "livetv_guide_channels" ALTER COLUMN "guideSourceId" SET NOT NULL;

-- Column types: the stats are read in the server zone, roles and subtitle tags are JSON arrays, group dates are dates.
CREATE FUNCTION pg_temp.date_or_null(t text) RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN t::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;
ALTER TABLE "item_groups" DISABLE TRIGGER set_updated_at;
ALTER TABLE "item_groups" ALTER COLUMN "airDate" TYPE date USING pg_temp.date_or_null("airDate");
ALTER TABLE "item_groups" ENABLE TRIGGER set_updated_at;
DROP FUNCTION pg_temp.date_or_null(text);

ALTER TABLE "subtitle_provider_stats" ALTER COLUMN "queryDate" TYPE timestamptz USING "queryDate" AT TIME ZONE 'UTC';

ALTER TABLE "roles" ALTER COLUMN "permissions" DROP DEFAULT;
ALTER TABLE "roles" ALTER COLUMN "permissions" TYPE jsonb USING "permissions"::jsonb;
ALTER TABLE "roles" ALTER COLUMN "permissions" SET DEFAULT '[]';
ALTER TABLE "roles" DISABLE TRIGGER set_updated_at;
UPDATE "roles" SET "permissions" = '[]'
 WHERE jsonb_typeof("permissions") <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements("permissions") e WHERE jsonb_typeof(e) <> 'string');
ALTER TABLE "roles" ENABLE TRIGGER set_updated_at;
ALTER TABLE "roles" ADD CONSTRAINT "CK_roles_permissions" CHECK (jsonb_typeof("permissions") = 'array');

ALTER TABLE "subtitle_files" DISABLE TRIGGER set_updated_at;
UPDATE "subtitle_files" SET "tags" = '[]' WHERE "tags" !~ '^\s*\[.*\]\s*$';
ALTER TABLE "subtitle_files" ENABLE TRIGGER set_updated_at;
ALTER TABLE "subtitle_files" ALTER COLUMN "tags" DROP DEFAULT;
ALTER TABLE "subtitle_files" ALTER COLUMN "tags" TYPE jsonb USING "tags"::jsonb;
ALTER TABLE "subtitle_files" ALTER COLUMN "tags" SET DEFAULT '[]';
ALTER TABLE "subtitle_files" ADD CONSTRAINT "CK_subtitle_files_tags" CHECK (jsonb_typeof("tags") = 'array');

ALTER TABLE "items" DROP COLUMN "searchVector";

-- The cascades of the new keys and the dedupe lookups of closed queue rows.
CREATE INDEX "IDX_recommendation_dismissals_mediaId" ON "recommendation_dismissals" ("mediaId");
CREATE INDEX "IDX_pairing_requests_approvedByUserId" ON "pairing_requests" ("approvedByUserId");
CREATE INDEX "IDX_oidc_logins_expectUserId" ON "oidc_logins" ("expectUserId");
CREATE INDEX "IDX_book_merges_folderId" ON "book_merges" ("folderId");
CREATE INDEX "IDX_acquisition_queue_closed_ref" ON "acquisition_queue" ("pluginId", "ref", "id" DESC) WHERE "finishedAt" IS NOT NULL;

-- A unique index on a subset of the foreign key's columns already bounds each lookup, and the item markers
-- index repeats the leading column of another.
DROP INDEX "IDX_movie_details_mediaId_kind";
DROP INDEX "IDX_series_details_mediaId_kind";
DROP INDEX "IDX_book_details_media_kind";
DROP INDEX "IDX_comic_details_media_kind";
DROP INDEX "IDX_album_details_media_kind";
DROP INDEX "IDX_track_details_item_media";
DROP INDEX "IDX_comic_issues_item_media";
DROP INDEX "IDX_item_markers_item";

-- An edition is readable through its work's library; the column had no writer.
ALTER TABLE "editions" DROP COLUMN "libraryId";
