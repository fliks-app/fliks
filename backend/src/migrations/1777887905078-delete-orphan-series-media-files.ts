import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeleteOrphanSeriesMediaFiles1777887905078
  implements MigrationInterface
{
  name = 'DeleteOrphanSeriesMediaFiles1777887905078';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "media_files"
       WHERE "episodeId" IS NULL
         AND "mediaId" IN (SELECT "id" FROM "media" WHERE "type" = 'series')`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: the deleted rows pointed at non-episode files that
    // were polluting series detail pages; restoring them would re-create
    // the bug.
  }
}
