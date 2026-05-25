import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDownloadHistoryEpisodeSeason1779400000000
  implements MigrationInterface
{
  name = 'AddDownloadHistoryEpisodeSeason1779400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "download_history"
        ADD COLUMN IF NOT EXISTS "episodeId" int,
        ADD COLUMN IF NOT EXISTS "seasonId" int
    `);
    // SET NULL on delete so a removed episode/season doesn't erase the
    // history row — the media link must be preserved at all costs
    // (see the "never unlink" invariant in completion.service).
    await queryRunner.query(`
      ALTER TABLE "download_history"
        ADD CONSTRAINT "FK_download_history_episode"
        FOREIGN KEY ("episodeId") REFERENCES "episodes"("id")
        ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "download_history"
        ADD CONSTRAINT "FK_download_history_season"
        FOREIGN KEY ("seasonId") REFERENCES "seasons"("id")
        ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "download_history"
        DROP CONSTRAINT IF EXISTS "FK_download_history_season",
        DROP CONSTRAINT IF EXISTS "FK_download_history_episode",
        DROP COLUMN IF EXISTS "seasonId",
        DROP COLUMN IF EXISTS "episodeId"
    `);
  }
}
