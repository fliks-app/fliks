-- A chosen track proposal leaves the singer queue but keeps its singer's turn (karaoke.md rule 31)
ALTER TABLE "watch_party_proposals" ADD COLUMN "chosenAt" timestamptz;
