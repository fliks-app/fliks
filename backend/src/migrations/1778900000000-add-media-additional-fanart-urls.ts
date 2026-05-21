import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaAdditionalFanartUrls1778900000000
  implements MigrationInterface
{
  name = 'AddMediaAdditionalFanartUrls1778900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        ADD COLUMN IF NOT EXISTS "additionalFanartUrls" text[] NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        DROP COLUMN IF EXISTS "additionalFanartUrls"
    `);
  }
}
