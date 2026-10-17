ALTER TABLE "indexers" ADD COLUMN IF NOT EXISTS "enableInteractiveSearch" boolean NOT NULL DEFAULT true;

  -- Backfilled from the column that used to gate both kinds of search: a row with searches off
  -- must not come out of this migration answering manual ones. New rows take the default.
  UPDATE "indexers" SET "enableInteractiveSearch" = "enableSearch"
