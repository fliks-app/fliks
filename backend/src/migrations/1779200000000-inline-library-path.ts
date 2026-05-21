import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Move `path` + `label` from `root_folders` onto `libraries` and drop the
 * table. `media.libraryId` already exists and is the only anchor going
 * forward; `media.rootFolderId` is dropped at the same time along with
 * its FK. Same surgery on `requests.rootFolderId`.
 */
export class InlineLibraryPath1779200000000 implements MigrationInterface {
  name = 'InlineLibraryPath1779200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "path" varchar`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "label" varchar`,
    );

    // 1:1 from the prior migration — safe to backfill with a join.
    await queryRunner.query(
      `UPDATE "libraries" lib
          SET "path"  = rf.path,
              "label" = rf.label
         FROM "root_folders" rf
        WHERE rf."libraryId" = lib.id`,
    );

    // Drop FKs pointing at root_folders so the table can be removed.
    await queryRunner.query(
      `ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "FK_ecd8a0e3718ba485b1cfffd5999"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP COLUMN IF EXISTS "rootFolderId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "FK_11390ba18a01b3f758bd13dd7b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "requests" DROP COLUMN IF EXISTS "rootFolderId"`,
    );

    await queryRunner.query(`DROP TABLE IF EXISTS "root_folders"`);
  }

  public async down(): Promise<void> {
    // No rollback.
  }
}
