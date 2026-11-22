-- The playback state's `updatedAt` right after KOReader's own last write: a later one is a write it has not seen.
ALTER TABLE "kosync_progress" ADD COLUMN "stateAt" timestamptz;
