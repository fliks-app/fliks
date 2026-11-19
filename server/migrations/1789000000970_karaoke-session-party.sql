-- Stems of a track made by the engine's Separate job (karaoke.md rule 11)
CREATE TABLE "derived_audio" (
  "id" serial NOT NULL,
  "mediaFileId" integer NOT NULL,
  "kind" text NOT NULL CONSTRAINT "CK_derived_audio_kind" CHECK ("kind" IN ('vocals', 'instrumental', 'guide')),
  "model" text NOT NULL,
  "modelVersion" text NOT NULL,
  "provider" text NOT NULL,
  "path" text NOT NULL,
  "size" bigint NOT NULL CONSTRAINT "CK_derived_audio_size" CHECK ("size" >= 0),
  "durationMs" integer NOT NULL,
  "lastUsedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_derived_audio" PRIMARY KEY ("id"),
  CONSTRAINT "FK_derived_audio_media_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "UQ_derived_audio_file_kind" ON "derived_audio" ("mediaFileId", "kind");
CREATE INDEX "IDX_derived_audio_last_used" ON "derived_audio" ("lastUsedAt");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "derived_audio" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One queue per party: each programme row names who added it, the singer queue is the programme
ALTER TABLE "watch_party_items" ADD COLUMN "addedBy" integer;
UPDATE "watch_party_items" i SET "addedBy" = p."ownerId" FROM "watch_parties" p WHERE p.id = i."partyId";
ALTER TABLE "watch_party_items"
  ADD CONSTRAINT "FK_watch_party_items_addedBy" FOREIGN KEY ("addedBy") REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_watch_party_items_addedBy" ON "watch_party_items" ("addedBy");

-- "Take turns" host switch
ALTER TABLE "watch_parties" ADD COLUMN "rotation" boolean NOT NULL DEFAULT false;

-- Proposals and votes only exist before the start
DELETE FROM "watch_party_proposals" p USING "watch_parties" w
  WHERE w.id = p."partyId" AND w.status <> 'scheduled';

-- The one playback an account has at a time, and its opt-in (session.md)
CREATE TABLE account_sessions (
  "userId" integer PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  "sessionId" text NOT NULL,
  epoch bigint NOT NULL,
  "itemId" integer NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  "mediaFileId" integer REFERENCES media_files (id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('movie', 'series', 'book', 'comic', 'album')),
  state text NOT NULL CHECK (state IN ('playing', 'paused', 'buffering', 'parked')),
  "positionSeconds" double precision NOT NULL,
  "durationSeconds" double precision,
  "ownerTargetId" text,
  "ownerDeviceName" text,
  "ownerFormFactor" text,
  queue jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "IDX_account_sessions_item" ON account_sessions ("itemId");
CREATE INDEX "IDX_account_sessions_media_file" ON account_sessions ("mediaFileId");

ALTER TABLE users ADD COLUMN "sessionSync" boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN "sessionKinds" text[]
  CHECK ("sessionKinds" <@ ARRAY['movie', 'series', 'book', 'comic', 'album']::text[]);

-- Playback start time and fallback reloads of a QoE session
ALTER TABLE "playback_qoe_sessions"
  ADD COLUMN "startupMs" integer,
  ADD COLUMN "startupCause" character varying,
  ADD COLUMN "fallbackReloads" integer NOT NULL DEFAULT 0;

UPDATE "playback_qoe_sessions" s SET "fallbackReloads" = e.n
FROM (
  SELECT "sessionId", count(*)::int AS n FROM "playback_qoe_events"
  WHERE "type" = 'reload' AND "data"->>'reason' LIKE '%\_fallback'
  GROUP BY "sessionId"
) e
WHERE s."sessionId" = e."sessionId";

ALTER TABLE users ADD COLUMN "whatsNewEnabled" boolean NOT NULL DEFAULT true;
-- NULL (an account created later) records the running version without showing notes.
ALTER TABLE users ADD COLUMN "whatsNewSeen" text;
-- Existing accounts see the notes shipped after 5.0.0.
ALTER TABLE users DISABLE TRIGGER set_updated_at;
UPDATE users SET "whatsNewSeen" = '5.0.0';
ALTER TABLE users ENABLE TRIGGER set_updated_at;
