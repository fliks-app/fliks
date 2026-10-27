ALTER TABLE "watch_party_invitees" DROP CONSTRAINT IF EXISTS "CHK_watch_party_invitees_source";
ALTER TABLE "watch_party_invitees"
  ADD CONSTRAINT "CHK_watch_party_invitees_source" CHECK ("source" IN ('invite', 'link', 'public', 'kicked'));
