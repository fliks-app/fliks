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
  ADD COLUMN "allowRename" boolean NOT NULL DEFAULT false;

CREATE INDEX "IDX_libraries_optimize_profile" ON "libraries" ("optimizeProfileId");

CREATE TABLE "jobs" (
  "id" bigserial PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('optimize', 'verify')),
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
  "finishedAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "UQ_jobs_active_file" ON "jobs" ("mediaFileId")
  WHERE "mediaFileId" IS NOT NULL AND "state" IN ('queued', 'leased', 'staged', 'committing');
CREATE INDEX "IDX_jobs_media_file" ON "jobs" ("mediaFileId");
CREATE INDEX "IDX_jobs_take" ON "jobs" ("priority" DESC, "id") WHERE "state" = 'queued';
CREATE INDEX "IDX_jobs_lease" ON "jobs" ("leaseUntil") WHERE "state" = 'leased';

CREATE TABLE "client_codecs" (
  "id" serial PRIMARY KEY,
  "deviceLabel" text NOT NULL,
  "platform" text NOT NULL,
  "directPlayProfiles" jsonb NOT NULL,
  "codecConditions" jsonb,
  "supportsHdr" boolean,
  "supportsDolbyVision" boolean,
  "firstSeenAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("deviceLabel", "platform")
);
