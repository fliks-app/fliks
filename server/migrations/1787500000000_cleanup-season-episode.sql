ALTER TABLE "cleanup_rules"
  ADD COLUMN "level" text NOT NULL DEFAULT 'movie' CHECK ("level" IN ('movie', 'series', 'season', 'episode')),
  ADD COLUMN "deleteSeriesWhenEmpty" boolean NOT NULL DEFAULT false;

UPDATE "cleanup_rules" SET "level" = 'series' WHERE "criteria"->>'mediaType' = 'series';

ALTER TABLE "cleanup_candidates"
  DROP CONSTRAINT "cleanup_candidates_pkey",
  ADD COLUMN "id" SERIAL PRIMARY KEY,
  ADD COLUMN "seasonId" integer REFERENCES "seasons"("id") ON DELETE CASCADE,
  ADD COLUMN "episodeId" integer REFERENCES "episodes"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "UQ_cleanup_candidates_scope" ON "cleanup_candidates" ("mediaId", "seasonId", "episodeId") NULLS NOT DISTINCT;
CREATE INDEX "IDX_cleanup_candidates_seasonId" ON "cleanup_candidates" ("seasonId");
CREATE INDEX "IDX_cleanup_candidates_episodeId" ON "cleanup_candidates" ("episodeId");

ALTER TABLE "cleanup_exclusions"
  DROP CONSTRAINT "cleanup_exclusions_pkey",
  ADD COLUMN "id" SERIAL PRIMARY KEY,
  ADD COLUMN "seasonId" integer REFERENCES "seasons"("id") ON DELETE CASCADE,
  ADD COLUMN "episodeId" integer REFERENCES "episodes"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "UQ_cleanup_exclusions_scope" ON "cleanup_exclusions" ("mediaId", "seasonId", "episodeId") NULLS NOT DISTINCT;
CREATE INDEX "IDX_cleanup_exclusions_seasonId" ON "cleanup_exclusions" ("seasonId");
CREATE INDEX "IDX_cleanup_exclusions_episodeId" ON "cleanup_exclusions" ("episodeId");
