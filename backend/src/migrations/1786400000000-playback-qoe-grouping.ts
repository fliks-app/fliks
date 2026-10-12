import { MigrationInterface, QueryRunner } from 'typeorm';

/** Group sessions of one viewing, split truthful CMCD from the client claim, keep diagnosis inputs. */
export class PlaybackQoeGrouping1786400000000 implements MigrationInterface {
  name = 'PlaybackQoeGrouping1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_sessions"
        ADD "playbackId" character varying(64),
        ADD "cmcdClaimed" boolean NOT NULL DEFAULT false,
        ADD "stallBufferAheadS" double precision,
        ADD "stallBandwidthBps" double precision,
        ADD "cmcdThroughputBps" double precision,
        ADD "unrecoveredError" boolean NOT NULL DEFAULT false,
        ADD "sampleCount" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `UPDATE "playback_qoe_sessions" SET "cmcdClaimed" = "cmcd"`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_sessions_playback" ON "playback_qoe_sessions" ("playbackId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_playback_qoe_sessions_playback"`);
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_sessions"
        DROP COLUMN "sampleCount",
        DROP COLUMN "unrecoveredError",
        DROP COLUMN "cmcdThroughputBps",
        DROP COLUMN "stallBandwidthBps",
        DROP COLUMN "stallBufferAheadS",
        DROP COLUMN "cmcdClaimed",
        DROP COLUMN "playbackId"`,
    );
  }
}
