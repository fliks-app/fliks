-- Files created before "optimize new files" was turned on are never queued automatically.
ALTER TABLE "libraries" ADD COLUMN "optimizeNewFilesSince" timestamptz NOT NULL DEFAULT now();

-- `deviceWeights` was stored and never read.
UPDATE "app_settings" SET "value" = ("value"::jsonb - 'deviceWeights')::text
 WHERE "key" = 'optimize_settings' AND "value"::jsonb ? 'deviceWeights';

-- `client_codecs` is keyed on the stable client device id; a client that sends none keeps label|platform.
ALTER TABLE "client_codecs" ADD COLUMN "deviceId" text;
UPDATE "client_codecs" SET "deviceId" = "deviceLabel" || '|' || "platform";
ALTER TABLE "client_codecs" ALTER COLUMN "deviceId" SET NOT NULL,
  DROP CONSTRAINT "client_codecs_deviceLabel_platform_key",
  ADD CONSTRAINT "client_codecs_deviceId_key" UNIQUE ("deviceId");
