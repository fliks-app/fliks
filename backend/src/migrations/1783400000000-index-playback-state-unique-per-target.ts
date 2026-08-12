import { MigrationInterface, QueryRunner } from 'typeorm';

// The two partial unique indexes `PlaybackState` declares, for databases whose baseline
// predates them. `IF NOT EXISTS` because every running install already had them created
// at boot, which is what this migration replaces.
export class IndexPlaybackStateUniquePerTarget1783400000000
  implements MigrationInterface
{
  name = 'IndexPlaybackStateUniquePerTarget1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_playback_user_movie" ON "playback_states" ("userId", "mediaId") WHERE "episodeId" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_playback_user_episode" ON "playback_states" ("userId", "episodeId") WHERE "episodeId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_playback_user_episode"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_playback_user_movie"`);
  }
}
