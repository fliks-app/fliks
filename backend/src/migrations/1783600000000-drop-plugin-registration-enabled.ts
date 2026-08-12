import { MigrationInterface, QueryRunner } from 'typeorm';

// An operator's decision to switch a plugin off belongs to the installed artifact, which exists
// for both tiers; `plugin_packages.enabled` is that flag. Two of them could only disagree.
export class DropPluginRegistrationEnabled1783600000000
  implements MigrationInterface
{
  name = 'DropPluginRegistrationEnabled1783600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "plugin_packages" p SET "enabled" = false
         FROM "plugin_registrations" r
        WHERE r."pluginId" = p."pluginId" AND r."enabled" = false`,
    );
    await queryRunner.query(`ALTER TABLE "plugin_registrations" DROP COLUMN IF EXISTS "enabled"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plugin_registrations" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true`,
    );
  }
}
