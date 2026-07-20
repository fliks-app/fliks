import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `translation_providers` table (admin-configured machine-translation
 * providers, several selectable at translate time) and provenance columns on
 * `subtitle_files` recording which provider/engine/model produced a translated
 * subtitle. Existing `translated` rows keep the columns null (generic origin).
 */
export class CreateTranslationProviders1782300000000
  implements MigrationInterface
{
  name = 'CreateTranslationProviders1782300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "translation_providers_engine_enum"
        AS ENUM ('gemini', 'openai', 'libretranslate')
    `);
    await queryRunner.query(`
      CREATE TABLE "translation_providers" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "name" varchar NOT NULL,
        "engine" "translation_providers_engine_enum" NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "isDefault" boolean NOT NULL DEFAULT false,
        "settings" jsonb NOT NULL DEFAULT '{}'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "subtitle_files"
        ADD COLUMN "translationProviderId" int,
        ADD COLUMN "translationEngine" varchar,
        ADD COLUMN "translationModel" varchar,
        ADD CONSTRAINT "FK_subtitle_files_translation_provider"
          FOREIGN KEY ("translationProviderId")
          REFERENCES "translation_providers"("id") ON DELETE SET NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subtitle_files"
        DROP CONSTRAINT IF EXISTS "FK_subtitle_files_translation_provider",
        DROP COLUMN IF EXISTS "translationProviderId",
        DROP COLUMN IF EXISTS "translationEngine",
        DROP COLUMN IF EXISTS "translationModel"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "translation_providers"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "translation_providers_engine_enum"`,
    );
  }
}
