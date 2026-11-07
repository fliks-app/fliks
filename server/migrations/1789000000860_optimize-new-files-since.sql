-- Files created before "optimize new files" was turned on are never queued automatically.
ALTER TABLE "libraries" ADD COLUMN "optimizeNewFilesSince" timestamptz NOT NULL DEFAULT now();
