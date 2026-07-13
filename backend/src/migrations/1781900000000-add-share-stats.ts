import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShareStats1781900000000 implements MigrationInterface {
  name = 'AddShareStats1781900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareStats" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "shareStats"`,
    );
  }
}
