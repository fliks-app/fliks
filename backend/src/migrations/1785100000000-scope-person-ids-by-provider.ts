import { MigrationInterface, QueryRunner } from 'typeorm';

/** Person ids are provider-scoped: TVDB credits store a TVDB people id, so the
 *  id alone is not unique and says nothing about who can resolve it. */
export class ScopePersonIdsByProvider1785100000000
  implements MigrationInterface
{
  name = 'ScopePersonIdsByProvider1785100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "persons" ADD COLUMN IF NOT EXISTS "provider" character varying(16) NOT NULL DEFAULT 'tmdb'`,
    );
    await queryRunner.query(
      `ALTER TABLE "persons" DROP CONSTRAINT IF EXISTS "UQ_4069db2315833af2a2bcdc59c42"`,
    );
    await queryRunner.query(
      `ALTER TABLE "persons" ADD CONSTRAINT "UQ_677a19ecc46b5da7b1a4314c82b" UNIQUE ("provider", "tmdbId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "persons" DROP CONSTRAINT IF EXISTS "UQ_677a19ecc46b5da7b1a4314c82b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "persons" ADD CONSTRAINT "UQ_4069db2315833af2a2bcdc59c42" UNIQUE ("tmdbId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "persons" DROP COLUMN IF EXISTS "provider"`,
    );
  }
}
