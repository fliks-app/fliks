import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaTmdbCollection1778600000000 implements MigrationInterface {
  name = 'AddMediaTmdbCollection1778600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        ADD COLUMN IF NOT EXISTS "tmdbCollectionId"   integer,
        ADD COLUMN IF NOT EXISTS "tmdbCollectionName" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        DROP COLUMN IF EXISTS "tmdbCollectionId",
        DROP COLUMN IF EXISTS "tmdbCollectionName"
    `);
  }
}
