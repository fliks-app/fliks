import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIndexerCapsSearchFallback1778500000000
  implements MigrationInterface
{
  name = 'AddIndexerCapsSearchFallback1778500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "indexers"
        ADD COLUMN IF NOT EXISTS "capsMovieSearch" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "capsTvSearch"    boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "capsSearchFallback" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "indexers"
        DROP COLUMN IF EXISTS "capsMovieSearch",
        DROP COLUMN IF EXISTS "capsTvSearch",
        DROP COLUMN IF EXISTS "capsSearchFallback"
    `);
  }
}
