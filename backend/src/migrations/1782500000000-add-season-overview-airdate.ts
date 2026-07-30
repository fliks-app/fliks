import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-season synopsis and air date. Both are already fetched into
 * `SeasonDetails` but were never persisted. `airDate` is a varchar, not a date:
 * TVDB reports a bare year for a season, which a date column would reject or
 * silently widen into a fabricated 1 January.
 */
export class AddSeasonOverviewAirDate1782500000000
  implements MigrationInterface
{
  name = 'AddSeasonOverviewAirDate1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "seasons" ADD COLUMN IF NOT EXISTS "overview" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "seasons" ADD COLUMN IF NOT EXISTS "airDate" character varying(10)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "seasons" DROP COLUMN IF EXISTS "airDate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "seasons" DROP COLUMN IF EXISTS "overview"`,
    );
  }
}
