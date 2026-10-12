import { MigrationInterface, QueryRunner } from 'typeorm';

/** Stalled milliseconds per classified cause, so a playback verdict can follow the stall causes. */
export class AddQoeStallCauses1786400000000 implements MigrationInterface {
  name = 'AddQoeStallCauses1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_sessions" ADD COLUMN "stallCauseMs" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "playback_qoe_sessions" DROP COLUMN "stallCauseMs"`,
    );
  }
}
