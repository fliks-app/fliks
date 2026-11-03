-- A finished merge keeps its record, so deleting the m4b does not merge the same parts again.
ALTER TABLE "book_merges" DROP CONSTRAINT "CK_book_merges_state";
ALTER TABLE "book_merges" ADD CONSTRAINT "CK_book_merges_state"
  CHECK ("state" IN ('running', 'failed', 'retry', 'replace', 'done'));
-- Set while a library's backfill runs, so a restart resumes it.
ALTER TABLE "libraries" ADD COLUMN "mergeM4bBackfill" boolean NOT NULL DEFAULT false;
