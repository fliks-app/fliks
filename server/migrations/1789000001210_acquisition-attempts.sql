-- The last search of the core acquisition sweep per media, family and language: what it found and why nothing was grabbed.
CREATE TABLE "acquisition_attempts" (
  "mediaId" integer NOT NULL REFERENCES "media" ("id") ON DELETE CASCADE,
  "family" text NOT NULL,
  "language" text NOT NULL DEFAULT '',
  "at" timestamptz NOT NULL,
  "outcome" text NOT NULL,
  "found" integer NOT NULL,
  "eligible" integer NOT NULL,
  "rejections" jsonb NOT NULL DEFAULT '[]',
  "failed" jsonb NOT NULL DEFAULT '[]',
  "nextAt" timestamptz,
  CONSTRAINT "PK_acquisition_attempts" PRIMARY KEY ("mediaId", "family", "language"),
  CONSTRAINT "CK_acquisition_attempts_outcome" CHECK ("outcome" IN ('grabbed', 'none', 'busy', 'timed_out'))
);
