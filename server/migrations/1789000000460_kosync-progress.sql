-- KOReader's last position per user and document, kept as the plugin sent it.
CREATE TABLE "kosync_progress" (
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "document" text NOT NULL,
  "mediaFileId" integer NOT NULL REFERENCES "media_files"("id") ON DELETE CASCADE,
  "progress" text NOT NULL,
  "percentage" double precision NOT NULL,
  "device" text NOT NULL,
  "deviceId" text,
  "syncedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_kosync_progress" PRIMARY KEY ("userId", "document"),
  CONSTRAINT "CK_kosync_progress_document" CHECK ("document" ~ '^[0-9a-f]{32}$')
);
CREATE INDEX "IDX_kosync_progress_mediaFileId" ON "kosync_progress" ("mediaFileId");
