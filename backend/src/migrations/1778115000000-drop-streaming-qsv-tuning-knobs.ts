import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropStreamingQsvTuningKnobs1778115000000 implements MigrationInterface {
  name = 'DropStreamingQsvTuningKnobs1778115000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "app_settings"
         WHERE "key" IN ('streaming_qsv_adaptive', 'streaming_qsv_lookahead')`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: `-adaptive_i / -adaptive_b` are now hard-enabled in
    // qsvExtra and `-look_ahead` is removed entirely (it tripped the
    // QSV→libx264 HW-accel fallback). BRC drift is handled by periodic
    // encoder rotation, not by these toggles.
  }
}
