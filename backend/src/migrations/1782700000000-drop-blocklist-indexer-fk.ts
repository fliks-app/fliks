import { MigrationInterface, QueryRunner } from 'typeorm';

// `indexers` becomes a plugin-owned table; core may no longer hold a
// cross-schema FK into it. The column and its data stay — indexerName is
// what the UI renders.
export class DropBlocklistIndexerFk1782700000000
  implements MigrationInterface
{
  name = 'DropBlocklistIndexerFk1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "blocklist" DROP CONSTRAINT IF EXISTS "FK_c0ad3d19ab0e2d7edb3b6468a7b"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "blocklist" SET "indexerId" = NULL WHERE "indexerId" IS NOT NULL AND "indexerId" NOT IN (SELECT "id" FROM "indexers")`,
    );
    await queryRunner.query(
      `ALTER TABLE "blocklist" ADD CONSTRAINT "FK_c0ad3d19ab0e2d7edb3b6468a7b" FOREIGN KEY ("indexerId") REFERENCES "indexers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }
}
