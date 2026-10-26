CREATE TABLE "watch_party_items" (
  "partyId" integer NOT NULL REFERENCES "watch_parties"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "mediaFileId" integer,
  "episodeId" integer REFERENCES "episodes"("id") ON DELETE CASCADE,
  PRIMARY KEY ("partyId", "position")
);

-- A party that follows a playlist keeps its rows; any other one is its current item alone.
INSERT INTO "watch_party_items" ("partyId", "position", "mediaId", "mediaFileId", "episodeId")
SELECT p."id", (row_number() OVER (PARTITION BY p."id" ORDER BY pi."position", pi."id") - 1)::int,
       pi."mediaId", NULL, pi."episodeId"
FROM "watch_parties" p JOIN "playlist_items" pi ON pi."playlistId" = p."playlistId"
WHERE p."status" IN ('scheduled', 'live');

INSERT INTO "watch_party_items" ("partyId", "position", "mediaId", "mediaFileId", "episodeId")
SELECT "id", 0, "mediaId", "mediaFileId", "episodeId" FROM "watch_parties"
WHERE "status" IN ('scheduled', 'live') AND "playlistId" IS NULL AND "mediaId" IS NOT NULL;

-- A scheduled party's item is the head of its programme; only a live one has the columns set.
ALTER TABLE "watch_parties" DROP CONSTRAINT "CHK_watch_parties_item_started";
ALTER TABLE "watch_parties"
  ADD CONSTRAINT "CHK_watch_parties_item_started" CHECK ("status" <> 'live' OR "mediaId" IS NOT NULL);
