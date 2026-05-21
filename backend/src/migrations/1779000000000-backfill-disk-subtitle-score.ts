import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Disk-discovered subtitles were previously stored with score=0 and
 * synced=false, putting them at the bottom of the selection order and
 * scheduling them for a sync pass even though a user-provided file on
 * disk is at least as trustworthy as an embedded track (score=100,
 * synced=true). Align them on the same defaults so they win against
 * same-language remote rows and aren't re-sync'd unnecessarily.
 * Only touches rows that still sit at the default score=0 — already-
 * rescored (e.g. via Whisper sync) entries are left untouched.
 */
export class BackfillDiskSubtitleScore1779000000000 implements MigrationInterface {
  name = 'BackfillDiskSubtitleScore1779000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "subtitle_files"
          SET "score" = 100,
              "synced" = true
        WHERE "providerType" = 'disk'
          AND "score" = 0`,
    );
  }

  public async down(): Promise<void> {
    // No rollback: we'd flip back legitimately-rescored rows to zero.
  }
}
