ALTER TABLE "cleanup_rules"
  ADD COLUMN "levels" text[] NOT NULL DEFAULT '{movie}'
    CHECK (cardinality("levels") >= 1 AND "levels" <@ ARRAY['movie', 'series', 'season', 'episode']);

UPDATE "cleanup_rules" SET "levels" = ARRAY["level"];

ALTER TABLE "cleanup_rules" DROP COLUMN "level";
