-- A smart playlist keeps its rules instead of rows: NULL is a static playlist (playlists.md rule 50)
ALTER TABLE "playlists"
  ADD COLUMN "rules" jsonb CONSTRAINT "CK_playlists_rules" CHECK (jsonb_typeof("rules") = 'object');
