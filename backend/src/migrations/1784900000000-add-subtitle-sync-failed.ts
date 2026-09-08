import { MigrationInterface, QueryRunner } from 'typeorm';

/** A sync failure is an axis of its own, beside `synced`: the file stays servable
 *  and the row keeps its acquisition status. */
export class AddSubtitleSyncFailed1784900000000 implements MigrationInterface {
  name = 'AddSubtitleSyncFailed1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" ADD COLUMN IF NOT EXISTS "syncFailed" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" DROP COLUMN IF EXISTS "syncFailed"`,
    );
  }
}
