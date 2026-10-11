import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEdlSupport1786000000000 implements MigrationInterface {
  name = 'AddEdlSupport1786000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "edlEnabled" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "edlAutoSkipCommercials" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `UPDATE "app_settings" SET "value" = "value" || ',.edl'
       WHERE "key" = 'companion_file_extensions' AND "value" <> ''
         AND ',' || replace(lower("value"), ' ', '') || ',' NOT LIKE '%,.edl,%'
         AND ',' || replace(lower("value"), ' ', '') || ',' NOT LIKE '%,edl,%'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "edlAutoSkipCommercials"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "edlEnabled"`);
  }
}
