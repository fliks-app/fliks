CREATE TABLE "media_release_dates" (
  "mediaId" integer NOT NULL,
  "kind" text NOT NULL,
  "date" date NOT NULL,
  CONSTRAINT "PK_media_release_dates" PRIMARY KEY ("mediaId", "kind"),
  CONSTRAINT "FK_media_release_dates_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
  CONSTRAINT "CK_media_release_dates_kind" CHECK ("kind" IN ('release', 'cinema', 'digital', 'physical'))
);
CREATE INDEX "IDX_media_release_dates_date" ON "media_release_dates" ("date");

INSERT INTO "media_release_dates" ("mediaId", "kind", "date")
SELECT "id", 'release', "releaseDate" FROM "media" WHERE "releaseDate" IS NOT NULL
UNION ALL SELECT "id", 'cinema', "inCinemas" FROM "media" WHERE "inCinemas" IS NOT NULL
UNION ALL SELECT "id", 'digital', "digitalRelease" FROM "media" WHERE "digitalRelease" IS NOT NULL
UNION ALL SELECT "id", 'physical', "physicalRelease" FROM "media" WHERE "physicalRelease" IS NOT NULL;

ALTER TABLE "media" DROP COLUMN "releaseDate", DROP COLUMN "inCinemas",
  DROP COLUMN "digitalRelease", DROP COLUMN "physicalRelease";
