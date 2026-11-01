CREATE TABLE "metadata_snapshots" (
  "provider" text NOT NULL,
  "resource" text NOT NULL,
  "kind" text NOT NULL,
  "externalId" text NOT NULL,
  "language" text NOT NULL DEFAULT '',
  "body" jsonb NOT NULL,
  "fetchedAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz,
  CONSTRAINT "PK_metadata_snapshots" PRIMARY KEY ("provider", "resource", "kind", "externalId", "language")
);
CREATE INDEX "IDX_metadata_snapshots_expires" ON "metadata_snapshots" ("expiresAt");

CREATE TABLE "media_field_sources" (
  "mediaId" integer NOT NULL,
  "field" text NOT NULL,
  "provider" text,
  "locked" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_media_field_sources" PRIMARY KEY ("mediaId", "field"),
  CONSTRAINT "FK_media_field_sources_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE
);
