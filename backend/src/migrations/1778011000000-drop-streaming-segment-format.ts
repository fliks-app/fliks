import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropStreamingSegmentFormat1778011000000 implements MigrationInterface {
  name = 'DropStreamingSegmentFormat1778011000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "app_settings" WHERE "key" = 'streaming_segment_format'`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: HLS output is fMP4-only now; the setting is no longer read.
  }
}
