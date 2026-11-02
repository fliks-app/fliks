ALTER TABLE "playback_states"
  ADD COLUMN "progression" double precision,
  ADD COLUMN "locator" jsonb,
  ADD CONSTRAINT "CK_playback_states_progression" CHECK ("progression" IS NULL OR "progression" BETWEEN 0 AND 1);
