import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Postgres does not index foreign keys on its own, and every subtitle pass
 * looks rows up by media file: the missing-search does one lookup per file and
 * the `/subtitles/missing` NOT EXISTS does one per (file, language). On a real
 * library that is a sequential scan of the whole table, thousands of times.
 */
export class IndexSubtitleFilesMedia1784700000000 implements MigrationInterface {
  name = 'IndexSubtitleFilesMedia1784700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_subtitle_files_mediaFileId" ON "subtitle_files" ("mediaFileId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_subtitle_files_mediaId" ON "subtitle_files" ("mediaId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subtitle_files_mediaFileId"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_subtitle_files_mediaId"`);
  }
}
