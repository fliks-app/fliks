import { MigrationInterface, QueryRunner } from 'typeorm';

// Stalled-download cleanup becomes one global policy owned by the acquisition
// bundle. Every library's profile was NULL and `cleanup_profiles` unused (see
// the plugin-system plan) — no value is carried forward, only the key renames.
export class DropCleanupProfiles1783200000000 implements MigrationInterface {
  name = 'DropCleanupProfiles1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "libraries" DROP COLUMN "stalledCleanupProfile"`,
    );
    await queryRunner.query(`DROP TABLE "cleanup_profiles"`);
    await queryRunner.query(
      `UPDATE "app_settings" SET "key" = 'plugin.download.stall_include_manual_grabs' WHERE "key" = 'cleanup_restart_manual_grabs'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "app_settings" SET "key" = 'cleanup_restart_manual_grabs' WHERE "key" = 'plugin.download.stall_include_manual_grabs'`,
    );
    await queryRunner.query(
      `CREATE TABLE "cleanup_profiles" ("key" character varying(16) NOT NULL, "samples" integer NOT NULL, "intervalMinutes" integer NOT NULL, "autoRestart" boolean NOT NULL DEFAULT true, CONSTRAINT "PK_51c4351ec9daef3fbdf1c0136a4" PRIMARY KEY ("key"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD "stalledCleanupProfile" character varying(16)`,
    );
  }
}
