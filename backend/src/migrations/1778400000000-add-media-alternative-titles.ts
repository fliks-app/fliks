import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaAlternativeTitles1778400000000
  implements MigrationInterface
{
  name = 'AddMediaAlternativeTitles1778400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media"
         ADD COLUMN IF NOT EXISTS "alternativeTitles" jsonb
         NOT NULL DEFAULT '[]'::jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" DROP COLUMN IF EXISTS "alternativeTitles"`,
    );
  }
}
