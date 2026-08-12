import { MigrationInterface, QueryRunner } from 'typeorm';

const OFFICIAL_CATALOG_URL = 'https://fliks-app.github.io/fliks-plugin-catalog/catalog.json';

/**
 * The official catalog source, seeded once so a fresh install has something to
 * browse without typing a URL. It's just the first row in `plugin_sources` —
 * nothing caps how many more an admin adds. No pinned key: refreshes fall
 * back to the compiled-in `OFFICIAL_KEYS` (`release-2026`).
 */
export class SeedOfficialPluginSource1783100000000 implements MigrationInterface {
  name = 'SeedOfficialPluginSource1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "plugin_sources" ("url", "enabled")
       SELECT $1::varchar, true
       WHERE NOT EXISTS (SELECT 1 FROM "plugin_sources" WHERE "url" = $1::varchar)`,
      [OFFICIAL_CATALOG_URL],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "plugin_sources" WHERE "url" = $1`, [OFFICIAL_CATALOG_URL]);
  }
}
