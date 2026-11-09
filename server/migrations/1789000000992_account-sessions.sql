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
