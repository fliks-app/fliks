import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds per-library overrides for the metadata language + region (null = inherit
 * the global metadata_language / metadata_region settings).
 */
export class AddLibraryMetadataLanguage1782100000000
  implements MigrationInterface
{
  name = 'AddLibraryMetadataLanguage1782100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "metadataLanguage" character varying(8)`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "metadataRegion" character varying(8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "libraries" DROP COLUMN IF EXISTS "metadataRegion"`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" DROP COLUMN IF EXISTS "metadataLanguage"`,
    );
  }
}
