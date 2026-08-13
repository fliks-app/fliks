import { MigrationInterface, QueryRunner } from 'typeorm';

// `episodes` has no index on the FK `seasonId` (Postgres never adds one automatically),
// so every coverage lookup (onDiskSql) correlated on it was a full table scan.
export class IndexEpisodesSeasonId1783700000000 implements MigrationInterface {
  name = 'IndexEpisodesSeasonId1783700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_episodes_season_hasfile_end" ON "episodes" ("seasonId", "hasFile", "endEpisodeNumber")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_episodes_season_hasfile_end"`,
    );
  }
}
