import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `ocr` provider type and `processing` status used by the
 * image-subtitle OCR pipeline. Postgres `ADD VALUE` can't be undone, so `down`
 * is a no-op — dropping an enum value requires recreating the type and
 * rewriting every dependent column, which isn't worth the risk for a reversal.
 */
export class AddOcrSubtitleEnumValues1780200000000
  implements MigrationInterface
{
  name = 'AddOcrSubtitleEnumValues1780200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_files_providertype_enum" ADD VALUE IF NOT EXISTS 'ocr'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_providers_type_enum" ADD VALUE IF NOT EXISTS 'ocr'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_files_status_enum" ADD VALUE IF NOT EXISTS 'processing'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE; intentionally irreversible.
  }
}
