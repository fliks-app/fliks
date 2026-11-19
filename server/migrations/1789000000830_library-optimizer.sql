CREATE TABLE "optimize_profiles" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "document" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "libraries"
  ADD COLUMN "optimizeProfileId" integer REFERENCES "optimize_profiles"("id") ON DELETE SET NULL,
  ADD COLUMN "optimizeNewFiles" boolean NOT NULL DEFAULT false,
  ADD COLUMN "allowRename" boolean NOT NULL DEFAULT false,
  -- Files created before "optimize new files" was turned on are never queued automatically.
  ADD COLUMN "optimizeNewFilesSince" timestamptz NOT NULL DEFAULT now();

CREATE INDEX "IDX_libraries_optimize_profile" ON "libraries" ("optimizeProfileId");

CREATE TABLE "jobs" (
  "id" bigserial PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('optimize', 'verify', 'separate')),
  "mediaFileId" integer REFERENCES "media_files"("id") ON DELETE SET NULL,
  "payload" jsonb NOT NULL,
  "profileHash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'queued' CHECK ("state" IN
    ('queued', 'leased', 'staged', 'committing', 'done', 'failed', 'skipped', 'cancelled')),
  "priority" integer NOT NULL DEFAULT 0,
  "notBefore" timestamptz NOT NULL DEFAULT now(),
  "attempt" integer NOT NULL DEFAULT 0,
  "failures" integer NOT NULL DEFAULT 0,
  "workerId" text,
  "deviceId" text,
  "leaseUntil" timestamptz,
  "progress" real NOT NULL DEFAULT 0,
  "paused" boolean NOT NULL DEFAULT false,
  "error" jsonb,
  "inPath" text,
  "inSize" bigint,
  "inMtimeMs" bigint,
  "inDev" bigint,
  "inIno" bigint,
  "stagedPath" text,
  "outSize" bigint,
  "outSha256" text,
  "result" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "startedAt" timestamptz,
  -- When the output was handed back: with `startedAt`, the encoding time the completion estimate uses.
  "encodedAt" timestamptz,
  "finishedAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "UQ_jobs_active_file" ON "jobs" ("mediaFileId")
  WHERE "mediaFileId" IS NOT NULL AND "state" IN ('queued', 'leased', 'staged', 'committing');
CREATE INDEX "IDX_jobs_media_file" ON "jobs" ("mediaFileId");
CREATE INDEX "IDX_jobs_take" ON "jobs" ("priority" DESC, "id") WHERE "state" = 'queued';
CREATE INDEX "IDX_jobs_lease" ON "jobs" ("leaseUntil") WHERE "state" = 'leased';

-- Keyed on the stable client device id; a client that sends none keeps label|platform.
CREATE TABLE "client_codecs" (
  "id" serial PRIMARY KEY,
  "deviceId" text NOT NULL UNIQUE,
  "deviceLabel" text NOT NULL,
  "platform" text NOT NULL,
  "directPlayProfiles" jsonb NOT NULL,
  "codecConditions" jsonb,
  "supportsHdr" boolean,
  "supportsDolbyVision" boolean,
  "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "worker_tokens" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE,
  "enabled" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz,
  "revokedAt" timestamptz,
  -- 'shared': the worker mounts the library (paths translated by pathMappings); 'none': it reads over HTTP and uploads.
  "pathAccess" text NOT NULL DEFAULT 'none' CHECK ("pathAccess" IN ('none', 'shared')),
  "pathMappings" jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- A moved or deleted file can no longer be optimised: its pending job ends here, whichever code path moved it.
CREATE FUNCTION "cancel_jobs_of_media_file"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "jobs"
     SET "state" = 'cancelled',
         "error" = '{"class":"cancelled","message":"media file moved or deleted"}'::jsonb,
         "finishedAt" = now(), "updatedAt" = now()
   WHERE "mediaFileId" = OLD."id" AND "state" IN ('queued', 'leased', 'staged');
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "media_files_cancel_jobs_delete" BEFORE DELETE ON "media_files"
  FOR EACH ROW EXECUTE FUNCTION "cancel_jobs_of_media_file"();

CREATE TRIGGER "media_files_cancel_jobs_move"
  BEFORE UPDATE OF "folderId", "relativePath" ON "media_files"
  FOR EACH ROW WHEN (OLD."folderId" IS DISTINCT FROM NEW."folderId"
                  OR OLD."relativePath" IS DISTINCT FROM NEW."relativePath")
  EXECUTE FUNCTION "cancel_jobs_of_media_file"();

-- `subtitle_ocr_delete_source` is replaced by `subtitles.image: ocr_then_drop` in a profile.
INSERT INTO "optimize_profiles" ("name", "document")
SELECT 'Image subtitles to text', '{
  "eligible": {"min_age_days": 0, "skip_hardlinked": true},
  "video": {"enabled": false, "when": {"codec": [], "min_bitrate": null, "only_if_transcoding_here": false, "skip_hdr10plus_dv": true},
            "codec": "auto", "goal": "space", "quality": "balanced", "max_resolution": "source", "prefer_software": false,
            "software_max_hours": 12, "too_slow": "hardware", "crop_in_file": false},
  "audio": {"languages": [], "drop_other_languages": false, "drop": [], "default": [], "reorder": false, "incompatible": "keep"},
  "subtitles": {"languages": [], "drop_other_languages": false, "image": "ocr_then_drop", "reorder": false},
  "file": {"clean": false, "container": "keep", "rename_tokens": false},
  "guards": {"min_savings_pct": 0, "vmaf_sample": "off"}
}'::jsonb
WHERE EXISTS (SELECT 1 FROM "app_settings" WHERE "key" = 'subtitle_ocr_delete_source' AND "value" = 'true');

DELETE FROM "app_settings" WHERE "key" = 'subtitle_ocr_delete_source';
