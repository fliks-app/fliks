-- The playback state's `updatedAt` right after KOReader's own last write: a later one is a write it has not seen.
ALTER TABLE "kosync_progress" ADD COLUMN "stateAt" timestamptz;

-- KOReader's last write still standing in the state: the same progression, so it has seen it.
UPDATE "kosync_progress" kp SET "stateAt" = ps."updatedAt"
  FROM "item_parts" p
  JOIN "playback_states" ps ON ps."itemId" = p."itemId"
 WHERE p."mediaFileId" = kp."mediaFileId" AND ps."userId" = kp."userId"
   AND ps."progression" = LEAST(GREATEST(kp."percentage", 0), 1);
