import { MigrationInterface, QueryRunner } from 'typeorm';

/** A failed subtitle row said nothing about why; the activity page now opens it. */
export class AddSubtitleErrorMessage1784800000000 implements MigrationInterface {
  name = 'AddSubtitleErrorMessage1784800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" ADD COLUMN IF NOT EXISTS "errorMessage" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" DROP COLUMN IF EXISTS "errorMessage"`,
    );
  }
}
