-- A finished merge keeps its record, so deleting the m4b does not merge the same parts again.
ALTER TABLE "book_merges" DROP CONSTRAINT "CK_book_merges_state";
ALTER TABLE "book_merges" ADD CONSTRAINT "CK_book_merges_state"
  CHECK ("state" IN ('running', 'failed', 'retry', 'replace', 'done'));
-- Raised by each turn-on of the option and cleared by the backfill that read that value, so a
-- restart resumes a cut backfill and a turn-on during the clearing is not lost.
ALTER TABLE "libraries" ADD COLUMN "mergeM4bBackfill" integer NOT NULL DEFAULT 0;
