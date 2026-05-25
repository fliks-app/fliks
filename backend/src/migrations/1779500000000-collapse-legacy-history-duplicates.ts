import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-shot cleanup of the duplicate `download_history` rows that
 * accumulated under the pre-PR-#238 orphan-cleanup bug. The cycle was:
 *
 *  1. Auto-grab creates row A (`status='grabbed'`).
 *  2. \`processCompleted\` couldn't match the qBit torrent (legacy rows
 *     had no \`torrentHash\`, or the name decode drifted) and deleted
 *     row A via \`historyRepo.remove(orphaned)\`.
 *  3. \`searchMissingEpisodes\` next tick: "no file on this episode!"
 *     → re-grabs → row B.
 *  4. Repeat. After months a single torrent ends up with 30+ identical
 *     `grabbed` rows.
 *
 * PR #238 removed step 2 — the deletes stopped — but the duplicates
 * accumulated up to that point are still on disk and feed an endless
 * import loop because each tick the cron picks ONE of them, re-copies
 * the destination file, and leaves the rest for next tick.
 *
 * This migration collapses every group of rows sharing
 * \`(mediaId, LOWER(sourceTitle))\` to its single most-recent entry.
 * The others get \`status='completed'\` + a marker statusMessage so the
 * audit trail still shows what happened.
 */
export class CollapseLegacyHistoryDuplicates1779500000000
  implements MigrationInterface
{
  name = 'CollapseLegacyHistoryDuplicates1779500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Helps the upcoming torrent-centric import loop too — every tick
    // looks up rows by `torrentHash`, so a partial-index on the
    // non-null hash values is worth the seconds it takes to build.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_download_history_torrentHash"
        ON "download_history" (LOWER("torrentHash"))
        WHERE "torrentHash" IS NOT NULL
    `);

    const result = await queryRunner.query(`
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
      WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
      RETURNING id
    `);
    const collapsed = Array.isArray(result?.[0]) ? result[0].length : 0;
    if (collapsed > 0) {
      console.log(
        `[CollapseLegacyHistoryDuplicates] collapsed ${collapsed} duplicate row(s)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best-effort revert: flip rows we marked back to `grabbed`. The
    // index drop is straightforward. The original `status` per row
    // isn't recoverable since the marker only says "duplicate".
    await queryRunner.query(`
      UPDATE "download_history"
      SET status = 'grabbed',
          "statusMessage" = NULL
      WHERE "statusMessage" = 'Legacy duplicate collapsed by 1779500000000 migration'
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_download_history_torrentHash"
    `);
  }
}
