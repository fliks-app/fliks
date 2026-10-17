ALTER TABLE "plugin_registrations" DROP COLUMN IF EXISTS "childUid";
ALTER TABLE "plugin_packages"
  ADD COLUMN "networkInternal" boolean NOT NULL DEFAULT false,
  ADD COLUMN "cwasmSha256" text,
  ADD COLUMN "cwasmEngine" text;
CREATE TABLE "plugin_scheduled_calls" (
  "pluginId" text NOT NULL,
  "key" text NOT NULL,
  "runAt" timestamptz NOT NULL,
  "payload" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 0,
  "version" bigint NOT NULL,
  PRIMARY KEY ("pluginId", "key")
);
CREATE SEQUENCE "plugin_scheduled_calls_version_seq";
CREATE INDEX "IDX_plugin_scheduled_calls_runAt" ON "plugin_scheduled_calls" ("runAt");
