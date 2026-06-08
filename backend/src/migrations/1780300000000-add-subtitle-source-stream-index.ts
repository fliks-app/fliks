import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records, on an OCR subtitle, the source image track's stream index so a
 * rescan can skip re-adding a burn-required track that was already OCR'd and
 * removed (matching by index, since such tracks are often language-untagged).
 */
export class AddSubtitleSourceStreamIndex1780300000000
  implements MigrationInterface
{
  name = 'AddSubtitleSourceStreamIndex1780300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" ADD COLUMN IF NOT EXISTS "sourceStreamIndex" integer`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" DROP COLUMN IF EXISTS "sourceStreamIndex"`,
    );
  }
}
