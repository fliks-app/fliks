-- The crash journal of a media move: planned sources and destinations, kept until every source is unlinked.
CREATE TABLE "media_moves" (
  "mediaId" integer PRIMARY KEY REFERENCES "media"("id") ON DELETE CASCADE,
  "plan" jsonb NOT NULL,
  "committed" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
