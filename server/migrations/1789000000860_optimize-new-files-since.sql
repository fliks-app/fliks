-- Files created before "optimize new files" was turned on are never queued automatically.
ALTER TABLE "libraries" ADD COLUMN "optimizeNewFilesSince" timestamptz NOT NULL DEFAULT now();

-- `deviceWeights` was stored and never read.
UPDATE "app_settings" SET "value" = ("value"::jsonb - 'deviceWeights')::text
 WHERE "key" = 'optimize_settings' AND "value"::jsonb ? 'deviceWeights';
