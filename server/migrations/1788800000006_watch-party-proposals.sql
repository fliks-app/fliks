CREATE TABLE IF NOT EXISTS "watch_party_proposals" (
  "id" SERIAL PRIMARY KEY,
  "partyId" int NOT NULL,
  "mediaId" int NOT NULL,
  "episodeId" int,
  "proposedBy" int NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "FK_watch_party_proposals_party" FOREIGN KEY ("partyId") REFERENCES "watch_parties"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_watch_party_proposals_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_watch_party_proposals_user" FOREIGN KEY ("proposedBy") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_watch_party_proposals_item"
  ON "watch_party_proposals" ("partyId", "mediaId", COALESCE("episodeId", 0));

CREATE TABLE IF NOT EXISTS "watch_party_votes" (
  "proposalId" int NOT NULL,
  "userId" int NOT NULL,
  CONSTRAINT "PK_watch_party_votes" PRIMARY KEY ("proposalId", "userId"),
  CONSTRAINT "FK_watch_party_votes_proposal" FOREIGN KEY ("proposalId") REFERENCES "watch_party_proposals"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_watch_party_votes_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);
