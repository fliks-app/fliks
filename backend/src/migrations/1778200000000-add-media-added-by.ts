import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaAddedBy1778200000000 implements MigrationInterface {
  name = 'AddMediaAddedBy1778200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "addedById" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" ADD CONSTRAINT "FK_media_addedById_users"
         FOREIGN KEY ("addedById") REFERENCES "users"("id")
         ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_media_addedById" ON "media" ("addedById")`,
    );

    // Backfill: media created via the Requests flow before this column existed
    // get their requester attributed retroactively. Picks the earliest known
    // request when a media was requested multiple times.
    await queryRunner.query(
      `UPDATE "media" m
         SET "addedById" = sub.user_id
         FROM (
           SELECT DISTINCT ON (r."mediaId") r."mediaId", r."userId" AS user_id
           FROM "requests" r
           WHERE r."mediaId" IS NOT NULL AND r."userId" IS NOT NULL
           ORDER BY r."mediaId", r."createdAt" ASC
         ) sub
         WHERE m.id = sub."mediaId" AND m."addedById" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_media_addedById"`);
    await queryRunner.query(
      `ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "FK_media_addedById_users"`,
    );
    await queryRunner.query(
      `ALTER TABLE "media" DROP COLUMN IF EXISTS "addedById"`,
    );
  }
}
