-- A track can be proposed again once played: only the pending proposal of an item is unique
ALTER TABLE "watch_party_proposals" DROP CONSTRAINT "UQ_watch_party_proposals_item";
CREATE UNIQUE INDEX "UQ_watch_party_proposals_pending" ON "watch_party_proposals" ("partyId", "itemId") WHERE "chosenAt" IS NULL;
