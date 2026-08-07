import { MigrationInterface, QueryRunner } from 'typeorm';

// Pre-existing duplicates must be collapsed first, or the unique index cannot be created.
export class AddBlocklistSourceTitleUniqueIndex1782600000000
  implements MigrationInterface
{
  name = 'AddBlocklistSourceTitleUniqueIndex1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "blocklist" b
      USING "blocklist" b2
      WHERE LOWER(b."sourceTitle") = LOWER(b2."sourceTitle")
        AND b.id > b2.id
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_blocklist_sourceTitle_lower" ON "blocklist" (LOWER("sourceTitle"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_blocklist_sourceTitle_lower"`,
    );
  }
}
