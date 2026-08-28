import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHideSpoilers1784300000000 implements MigrationInterface {
  name = 'AddHideSpoilers1784300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hideSpoilers" boolean NOT NULL DEFAULT false`,
    );
    for (const column of [
      'spoilerHideStills',
      'spoilerHideOverviews',
      'spoilerHideTitles',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "${column}" boolean NOT NULL DEFAULT true`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "hideSpoilers"`,
    );
    for (const column of [
      'spoilerHideStills',
      'spoilerHideOverviews',
      'spoilerHideTitles',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "users" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
