
      CREATE TYPE "translation_providers_engine_enum"
        AS ENUM ('gemini', 'openai', 'libretranslate');


      CREATE TABLE "translation_providers" (
        "id" SERIAL PRIMARY KEY,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "name" varchar NOT NULL,
        "engine" "translation_providers_engine_enum" NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        "isDefault" boolean NOT NULL DEFAULT false,
        "settings" jsonb NOT NULL DEFAULT '{}'
      );


      ALTER TABLE "subtitle_files"
        ADD COLUMN "translationProviderId" int,
        ADD COLUMN "translationEngine" varchar,
        ADD COLUMN "translationModel" varchar,
        ADD CONSTRAINT "FK_subtitle_files_translation_provider"
          FOREIGN KEY ("translationProviderId")
          REFERENCES "translation_providers"("id") ON DELETE SET NULL;
