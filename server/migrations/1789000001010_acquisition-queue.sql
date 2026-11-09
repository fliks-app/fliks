-- Acquisition queue and history (plugins.md rules 69-72): one row per provider transfer, open until a terminal state.
CREATE TABLE "acquisition_queue" (
  "id" serial PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "finishedAt" timestamptz,
  "pluginId" text NOT NULL,
  "ref" text NOT NULL,
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "season" integer,
  "episode" integer,
  "sourceId" text NOT NULL,
  "sourceName" text NOT NULL,
  "title" text NOT NULL,
  "quality" text NOT NULL,
  "method" text NOT NULL,
  "infoUrl" text,
  "state" text NOT NULL,
  "progress" double precision NOT NULL DEFAULT 0,
  "size" bigint,
  "bytesPerSecond" double precision,
  "eta" double precision,
  "error" text,
  CONSTRAINT "CK_acquisition_queue_state" CHECK ("state" IN
    ('queued', 'active', 'stalled', 'paused', 'importing', 'import_failed', 'imported', 'failed', 'removed')),
  CONSTRAINT "CK_acquisition_queue_method" CHECK ("method" IN ('manual', 'auto', 'rss')),
  CONSTRAINT "CK_acquisition_queue_closed" CHECK (
    ("finishedAt" IS NULL) = ("state" IN ('queued', 'active', 'stalled', 'paused', 'importing', 'import_failed')))
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "acquisition_queue" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A provider's open transfer is found by its ref; the open rows of a media are the in-flight read.
CREATE UNIQUE INDEX "UQ_acquisition_queue_open_ref" ON "acquisition_queue" ("pluginId", "ref") WHERE "finishedAt" IS NULL;
CREATE INDEX "IDX_acquisition_queue_media" ON "acquisition_queue" ("mediaId", "finishedAt");
CREATE INDEX "IDX_acquisition_queue_history" ON "acquisition_queue" ("finishedAt" DESC, "id" DESC) WHERE "finishedAt" IS NOT NULL;
