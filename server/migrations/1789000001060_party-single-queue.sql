-- One queue per party: each programme row names who added it, the singer queue is the programme
ALTER TABLE "watch_party_items" ADD COLUMN "addedBy" integer;
UPDATE "watch_party_items" i SET "addedBy" = p."ownerId" FROM "watch_parties" p WHERE p.id = i."partyId";
ALTER TABLE "watch_party_items"
  ADD CONSTRAINT "FK_watch_party_items_addedBy" FOREIGN KEY ("addedBy") REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_watch_party_items_addedBy" ON "watch_party_items" ("addedBy");

-- "Take turns" host switch
ALTER TABLE "watch_parties" ADD COLUMN "rotation" boolean NOT NULL DEFAULT false;

-- Proposals and votes only exist before the start; a chosen track proposal only kept a singer's turn
DELETE FROM "watch_party_proposals" p USING "watch_parties" w
  WHERE w.id = p."partyId" AND w.status <> 'scheduled';
DELETE FROM "watch_party_proposals" WHERE "chosenAt" IS NOT NULL;
DROP INDEX "UQ_watch_party_proposals_pending";
ALTER TABLE "watch_party_proposals" DROP COLUMN "chosenAt";
ALTER TABLE "watch_party_proposals" ADD CONSTRAINT "UQ_watch_party_proposals_item" UNIQUE ("partyId", "itemId");
