import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaFileOsdbHash1779300000000 implements MigrationInterface {
  name = 'AddMediaFileOsdbHash1779300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media_files"
        ADD COLUMN IF NOT EXISTS "osdbHash" varchar(16),
        ADD COLUMN IF NOT EXISTS "osdbBytesize" bigint
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "media_files"
        DROP COLUMN IF EXISTS "osdbHash",
        DROP COLUMN IF EXISTS "osdbBytesize"
    `);
  }
}
