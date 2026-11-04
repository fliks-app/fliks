-- Fields of an issue an admin edited by hand: a scan never fills them again (comics.md rule 35)
ALTER TABLE "comic_issues" ADD COLUMN "lockedFields" text[] NOT NULL DEFAULT '{}';
