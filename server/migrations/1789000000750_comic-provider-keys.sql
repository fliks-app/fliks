-- The provider's own key of an issue, kept apart from the editable kind, sort and label so a refresh
-- still matches an issue an admin renumbered (NULL: match on the live key)
ALTER TABLE "comic_issues"
  ADD COLUMN "providerKind" text,
  ADD COLUMN "providerSort" numeric,
  ADD COLUMN "providerLabel" text;

UPDATE "comic_issues" SET "providerKind" = "kind", "providerSort" = "sortNumber", "providerLabel" = "label";
