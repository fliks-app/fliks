import { MigrationInterface, QueryRunner } from 'typeorm';

/** Operator on/off switch, independent of `status` — an activation outcome, not a choice. */
export class AddPluginPackageEnabled1783500000000 implements MigrationInterface {
  name = 'AddPluginPackageEnabled1783500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_packages" ADD COLUMN "enabled" boolean NOT NULL DEFAULT true`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_packages" DROP COLUMN "enabled"`);
  }
}
