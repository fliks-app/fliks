import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSubtitleFileHashMatched1779310000000
  implements MigrationInterface
{
  name = 'AddSubtitleFileHashMatched1779310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subtitle_files"
        ADD COLUMN IF NOT EXISTS "hashMatched" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subtitle_files"
        DROP COLUMN IF EXISTS "hashMatched"
    `);
  }
}
