import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Snapshots the translation provider's display name onto a translated subtitle
 * so the source column can show the admin-given label (e.g. "Gemini Flash")
 * even after the provider is renamed or removed. Existing rows stay null and
 * fall back to the engine label.
 */
export class AddSubtitleTranslationProviderName1782400000000
  implements MigrationInterface
{
  name = 'AddSubtitleTranslationProviderName1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" ADD COLUMN "translationProviderName" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subtitle_files" DROP COLUMN IF EXISTS "translationProviderName"`,
    );
  }
}
