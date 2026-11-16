-- An album request scoped to some tracks: their MusicBrainz recording ids and the size of the target edition.
-- An album request carries its wants as a book request does.
ALTER TABLE "requests" ADD COLUMN "recordings" text[], ADD COLUMN "trackCount" integer,
  DROP CONSTRAINT "CK_requests_wants",
  ADD CONSTRAINT "CK_requests_wants" CHECK (("mediaType" IN ('book', 'album') AND kind = 'add') = ("wants" IS NOT NULL)),
  ADD CONSTRAINT "CK_requests_recordings" CHECK (
    "recordings" IS NULL OR ("mediaType" = 'album' AND kind = 'add' AND cardinality("recordings") > 0)),
  ADD CONSTRAINT "CK_requests_trackCount" CHECK ("trackCount" IS NULL OR "recordings" IS NOT NULL);

-- A track of a non-target edition is monitored only when a track want put it there: the tracks files made are not.
ALTER TABLE "items" DISABLE TRIGGER set_updated_at;
UPDATE "items" i SET monitored = false
  FROM "editions" e JOIN "album_details" ad ON ad."mediaId" = e."mediaId"
 WHERE e.id = i."editionId" AND e.family = 'audio' AND i.monitored
   AND ad."targetEditionId" IS NOT NULL AND ad."targetEditionId" <> e.id;
ALTER TABLE "items" ENABLE TRIGGER set_updated_at;
