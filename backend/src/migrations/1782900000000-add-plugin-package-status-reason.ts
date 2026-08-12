import { MigrationInterface, QueryRunner } from 'typeorm';

/** Carries why `register()` refused a package, so a `failed` row is attributable. */
export class AddPluginPackageStatusReason1782900000000 implements MigrationInterface {
  name = 'AddPluginPackageStatusReason1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_packages" ADD COLUMN "statusReason" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "plugin_packages" DROP COLUMN "statusReason"`);
  }
}
