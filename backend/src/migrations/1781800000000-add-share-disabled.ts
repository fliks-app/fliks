import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShareDisabled1781800000000 implements MigrationInterface {
  name = 'AddShareDisabled1781800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareDisabled" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "shareDisabled"`,
    );
  }
}
