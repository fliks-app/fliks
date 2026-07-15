import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `translated` provider type used by the subtitle machine-translation
 * pipeline (Gemini). Postgres `ADD VALUE` can't be undone, so `down` is a no-op
 * — dropping an enum value requires recreating the type and rewriting every
 * dependent column, which isn't worth the risk for a reversal.
 */
export class AddTranslatedSubtitleProviderType1782200000000
  implements MigrationInterface
{
  name = 'AddTranslatedSubtitleProviderType1782200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_files_providertype_enum" ADD VALUE IF NOT EXISTS 'translated'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."subtitle_providers_type_enum" ADD VALUE IF NOT EXISTS 'translated'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres has no DROP VALUE; intentionally irreversible.
  }
}
