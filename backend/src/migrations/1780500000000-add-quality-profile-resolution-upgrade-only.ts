import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddQualityProfileResolutionUpgradeOnly1780500000000
  implements MigrationInterface
{
  name = 'AddQualityProfileResolutionUpgradeOnly1780500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "quality_profiles"
        ADD COLUMN IF NOT EXISTS "resolutionUpgradeOnly" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "quality_profiles"
        DROP COLUMN IF EXISTS "resolutionUpgradeOnly"
    `);
  }
}
