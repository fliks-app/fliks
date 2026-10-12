import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-session playback quality rows and their point events, purged after qoeRetentionDays. */
export class CreatePlaybackQoe1786300000000 implements MigrationInterface {
  name = 'CreatePlaybackQoe1786300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "playback_qoe_sessions" (
        "sessionId" character varying(64) NOT NULL,
        "playbackId" character varying(64),
        "userId" integer,
        "mediaFileId" integer,
        "mediaTitle" character varying,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endedAt" TIMESTAMP WITH TIME ZONE,
        "deviceLabel" character varying,
        "systemName" character varying,
        "appVersion" character varying,
        "engine" character varying,
        "cmcd" boolean NOT NULL DEFAULT false,
        "cmcdClaimed" boolean NOT NULL DEFAULT false,
        "playMethod" character varying,
        "quality" character varying,
        "transcodeReasons" jsonb NOT NULL DEFAULT '[]',
        "videoCodec" character varying,
        "width" integer,
        "height" integer,
        "decoderName" character varying,
        "hwDecoder" boolean,
        "watchedMs" integer NOT NULL DEFAULT 0,
        "stallCount" integer NOT NULL DEFAULT 0,
        "stallMs" integer NOT NULL DEFAULT 0,
        "droppedFrames" integer,
        "decodedFrames" integer,
        "avgBandwidthBps" double precision,
        "minBandwidthBps" double precision,
        "avgVariantBitrate" double precision,
        "recoveryReloads" integer NOT NULL DEFAULT 0,
        "errorCount" integer NOT NULL DEFAULT 0,
        "medianTranscodeSpeed" double precision,
        "stallBufferAheadS" double precision,
        "stallBandwidthBps" double precision,
        "cmcdThroughputBps" double precision,
        "unrecoveredError" boolean NOT NULL DEFAULT false,
        "sampleCount" integer NOT NULL DEFAULT 0,
        "stallCauseMs" jsonb,
        "stallReasonMs" jsonb,
        "pipeline" jsonb,
        "verdict" character varying NOT NULL DEFAULT 'unknown',
        "confidence" character varying NOT NULL DEFAULT 'low',
        "reasons" jsonb NOT NULL DEFAULT '[]',
        "playbackVerdict" character varying NOT NULL DEFAULT 'unknown',
        "playbackConfidence" character varying NOT NULL DEFAULT 'low',
        CONSTRAINT "PK_playback_qoe_sessions" PRIMARY KEY ("sessionId")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_sessions_last_seen" ON "playback_qoe_sessions" ("lastSeenAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_sessions_playback_verdict" ON "playback_qoe_sessions" ("playbackVerdict")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_sessions_playback" ON "playback_qoe_sessions" ("userId", "playbackId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_sessions_device" ON "playback_qoe_sessions" ("deviceLabel")`,
    );
    await queryRunner.query(
      `CREATE TABLE "playback_qoe_events" (
        "id" SERIAL NOT NULL,
        "sessionId" character varying(64) NOT NULL,
        "at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "type" character varying NOT NULL,
        "data" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_playback_qoe_events" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_playback_qoe_events_session" ON "playback_qoe_events" ("sessionId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_events" ADD CONSTRAINT "FK_playback_qoe_events_session" FOREIGN KEY ("sessionId") REFERENCES "playback_qoe_sessions"("sessionId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_events" DROP CONSTRAINT "FK_playback_qoe_events_session"`,
    );
    await queryRunner.query(`DROP TABLE "playback_qoe_events"`);
    await queryRunner.query(`DROP TABLE "playback_qoe_sessions"`);
  }
}
