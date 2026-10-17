CREATE TABLE IF NOT EXISTS "indexer_sources" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" varchar NOT NULL,
  "implementation" varchar NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "priority" integer NOT NULL DEFAULT 1,
  "enabled" boolean NOT NULL DEFAULT true
)
