import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Postgres never indexes a foreign key on its own, and `channelId` is joined
 * or filtered on every admin channel list, every source sync, and the
 * `ON DELETE CASCADE` from a channel delete: all a sequential scan without it.
 */
export class IndexLivetvChannelStreamsChannel1785500000000 implements MigrationInterface {
  name = 'IndexLivetvChannelStreamsChannel1785500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_livetv_channel_streams_channelId" ON "livetv_channel_streams" ("channelId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_livetv_channel_streams_channelId"`);
  }
}
