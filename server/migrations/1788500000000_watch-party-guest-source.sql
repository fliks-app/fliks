ALTER TABLE "watch_party_invitees" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'invite';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_watch_party_invitees_source') THEN
    ALTER TABLE "watch_party_invitees"
      ADD CONSTRAINT "CHK_watch_party_invitees_source" CHECK ("source" IN ('invite', 'link'));
  END IF;
END $$;
