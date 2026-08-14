import { MigrationInterface, QueryRunner } from 'typeorm';

// Plugin children all dropped to one shared uid, so at kernel level each could read the others'
// /proc environ — token, socket paths and database credentials — and open their sockets. A uid per
// plugin separates them; it has to be stable, because the plugin's data directory is owned by it.
export class AddPluginRegistrationChildUid1783800000000
  implements MigrationInterface
{
  name = 'AddPluginRegistrationChildUid1783800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plugin_registrations" ADD COLUMN IF NOT EXISTS "childUid" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "plugin_registrations"
         ADD CONSTRAINT "UQ_plugin_registrations_child_uid" UNIQUE ("childUid")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plugin_registrations" DROP CONSTRAINT IF EXISTS "UQ_plugin_registrations_child_uid"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plugin_registrations" DROP COLUMN IF EXISTS "childUid"`,
    );
  }
}
