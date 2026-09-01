import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The stored condition shape (`{name, implementation, …}`) never matched what the
 * settings page sends, so every save was refused and the column only ever held
 * rows written straight through the API. Rewrites those to the shape both sides
 * now speak, dropping conditions whose kind isn't one we evaluate and formats
 * left with none — a conditionless format matched every release.
 */
export class CustomFormatSpecsAndMinScore1784600000000
  implements MigrationInterface
{
  name = 'CustomFormatSpecsAndMinScore1784600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "custom_formats" SET "specifications" = COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'type', s->>'implementation',
          'value', s->>'value',
          'negate', COALESCE((s->>'negate')::boolean, false),
          'required', COALESCE((s->>'required')::boolean, false)
        ))
        FROM jsonb_array_elements("specifications") s
        WHERE s->>'implementation' IN (
          'title_regex', 'source', 'resolution', 'language', 'release_flag',
          'release_group', 'edition', 'video_codec', 'audio_codec'
        )
      ), '[]'::jsonb)
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements("specifications") s
        WHERE s ? 'implementation'
      )
    `);
    await queryRunner.query(
      `DELETE FROM "custom_formats" WHERE jsonb_array_length("specifications") = 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_formats" RENAME COLUMN "specifications" TO "specs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "quality_profiles" ADD COLUMN IF NOT EXISTS "minCustomFormatScore" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "quality_profiles" DROP COLUMN IF EXISTS "minCustomFormatScore"`,
    );
    await queryRunner.query(
      `ALTER TABLE "custom_formats" RENAME COLUMN "specs" TO "specifications"`,
    );
    await queryRunner.query(`
      UPDATE "custom_formats" SET "specifications" = COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'name', s->>'type',
          'implementation', s->>'type',
          'value', s->>'value',
          'negate', COALESCE((s->>'negate')::boolean, false),
          'required', COALESCE((s->>'required')::boolean, false)
        ))
        FROM jsonb_array_elements("specifications") s
      ), '[]'::jsonb)
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements("specifications") s
        WHERE s ? 'type'
      )
    `);
  }
}
