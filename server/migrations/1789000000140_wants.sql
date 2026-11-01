ALTER TABLE "quality_profiles"
  ADD COLUMN "family" text NOT NULL DEFAULT 'video',
  ADD CONSTRAINT "CK_quality_profiles_family" CHECK ("family" IN ('video')),
  ADD CONSTRAINT "UQ_quality_profiles_id_family" UNIQUE ("id", "family");

ALTER TABLE "quality_definitions"
  ADD COLUMN "family" text NOT NULL DEFAULT 'video',
  ADD CONSTRAINT "CK_quality_definitions_family" CHECK ("family" IN ('video')),
  DROP CONSTRAINT "UQ_5f4831d8cb9a9bc845a98006aeb",
  ADD CONSTRAINT "UQ_quality_definitions_family_quality" UNIQUE ("family", "qualityId");

CREATE TABLE "wants" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "family" text NOT NULL,
  "language" text,
  "qualityProfileId" integer,
  "minimumAvailability" text NOT NULL DEFAULT 'released',
  CONSTRAINT "CK_wants_family" CHECK ("family" IN ('video')),
  CONSTRAINT "CK_wants_video_language" CHECK ("family" <> 'video' OR "language" IS NULL),
  CONSTRAINT "UQ_wants_media_family_language" UNIQUE NULLS NOT DISTINCT ("mediaId", "family", "language"),
  CONSTRAINT "FK_wants_quality_profile" FOREIGN KEY ("qualityProfileId", "family")
    REFERENCES "quality_profiles"("id", "family") ON DELETE SET NULL ("qualityProfileId")
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "wants" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX "IDX_wants_qualityProfileId" ON "wants" ("qualityProfileId");

INSERT INTO "wants" ("mediaId", "family", "qualityProfileId", "minimumAvailability")
SELECT "id", 'video', "qualityProfileId", "minimumAvailability" FROM "media" ORDER BY "id";

ALTER TABLE "media" DROP COLUMN "qualityProfileId", DROP COLUMN "minimumAvailability";
