import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A subtitle whose timing sync failed is still a servable file, so it can't
 * share `failed` with a row that has no file at all. Postgres `ADD VALUE` can't
 * be undone, so `down` is a no-op.
 */
export class AddSyncFailedSubtitleStatus1784900000000
  implements MigrationInterface
{
  name = 'AddSyncFailedSubtitleStatus1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_files_status_enum" ADD VALUE IF NOT EXISTS 'sync_failed'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE; intentionally irreversible.
  }
}
