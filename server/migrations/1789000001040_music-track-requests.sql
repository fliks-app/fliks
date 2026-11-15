-- An album request scoped to some tracks: their MusicBrainz recording ids and the size of the target edition.
-- An album request carries its wants as a book request does.
ALTER TABLE "requests" ADD COLUMN "recordings" text[], ADD COLUMN "trackCount" integer,
  DROP CONSTRAINT "CK_requests_wants",
  ADD CONSTRAINT "CK_requests_wants" CHECK (("mediaType" IN ('book', 'album') AND kind = 'add') = ("wants" IS NOT NULL)),
  ADD CONSTRAINT "CK_requests_recordings" CHECK (
    "recordings" IS NULL OR ("mediaType" = 'album' AND kind = 'add' AND cardinality("recordings") > 0)),
  ADD CONSTRAINT "CK_requests_trackCount" CHECK ("trackCount" IS NULL OR "recordings" IS NOT NULL);
