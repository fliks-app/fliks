CREATE INDEX IF NOT EXISTS "IDX_download_history_torrentHash"
  ON "download_history" (LOWER("torrentHash"))
  WHERE "torrentHash" IS NOT NULL;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "mediaId", LOWER("sourceTitle")
      ORDER BY "updatedAt" DESC, id DESC
    ) AS rn
  FROM "download_history"
  WHERE status IN ('grabbed', 'failed', 'warning')
    AND "mediaId" IS NOT NULL
    AND "sourceTitle" IS NOT NULL
)
UPDATE "download_history"
   SET status = 'completed',
       "statusMessage" = 'Legacy duplicate collapsed by 1779500000000 migration'
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
