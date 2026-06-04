import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clearlogo (transparent PNG title treatment) for media, stored as a local
 * image API path. Nullable — media without a provider logo, and rows created
 * before this migration, keep it null until the next metadata refresh.
 */
export class AddMediaLogoUrl1779800000000 implements MigrationInterface {
  name = 'AddMediaLogoUrl1779800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        ADD COLUMN IF NOT EXISTS "logoUrl" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media"
        DROP COLUMN IF EXISTS "logoUrl"
    `);
  }
}
