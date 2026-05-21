import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeasonPosterUrl1778800000000 implements MigrationInterface {
  name = 'AddSeasonPosterUrl1778800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seasons"
        ADD COLUMN IF NOT EXISTS "posterUrl" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "seasons"
        DROP COLUMN IF EXISTS "posterUrl"
    `);
  }
}
