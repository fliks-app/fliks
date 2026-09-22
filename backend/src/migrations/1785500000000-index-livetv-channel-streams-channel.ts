import { MigrationInterface, QueryRunner } from 'typeorm';

/** Postgres never indexes a foreign key on its own; `channelId` is joined or
 *  filtered on every admin list, source sync and cascade delete. */
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
