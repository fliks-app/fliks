import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndexerRequestDelay1778700000000 implements MigrationInterface {
  name = 'AddIndexerRequestDelay1778700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "indexers"
        ADD COLUMN IF NOT EXISTS "requestDelay" integer NOT NULL DEFAULT 2
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "indexers"
        DROP COLUMN IF EXISTS "requestDelay"
    `);
  }
}
