ALTER TABLE "watch_party_votes"
  ADD COLUMN "value" smallint NOT NULL DEFAULT 1 CONSTRAINT "CHK_watch_party_votes_value" CHECK ("value" IN (-1, 1));
