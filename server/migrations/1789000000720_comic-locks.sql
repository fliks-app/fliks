-- Fields of an issue an admin edited by hand: a scan never fills them again (comics.md rule 36)
ALTER TABLE "comic_issues"
  ADD COLUMN "lockedFields" text[] NOT NULL DEFAULT '{}'
    CONSTRAINT "CK_comic_issues_lockedFields"
    CHECK ("lockedFields" <@ ARRAY['label', 'sort', 'kind', 'title', 'overview', 'releaseDate']);
