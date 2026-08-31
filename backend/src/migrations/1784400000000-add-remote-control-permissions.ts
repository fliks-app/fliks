import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemoteControlPermissions1784400000000 implements MigrationInterface {
  name = 'AddRemoteControlPermissions1784400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'allowRemoteControlOfOthers',
      'allowRemoteControlOfMyDevices',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "${column}" boolean NOT NULL DEFAULT false`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'allowRemoteControlOfOthers',
      'allowRemoteControlOfMyDevices',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
