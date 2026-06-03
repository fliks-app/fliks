import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Local card art for requests: poster/fanart API paths stored at creation
 * so request cards render from the cached image pipeline instead of
 * fetching metadata + the TMDB CDN per card. Nullable — requests created
 * before this migration keep the client-side metadata fallback.
 */
export class AddRequestPosterFanartUrls1779700000000
  implements MigrationInterface
{
  name = 'AddRequestPosterFanartUrls1779700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "requests"
        ADD COLUMN IF NOT EXISTS "posterUrl" text,
        ADD COLUMN IF NOT EXISTS "fanartUrl" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "requests"
        DROP COLUMN IF EXISTS "posterUrl",
        DROP COLUMN IF EXISTS "fanartUrl"
    `);
  }
}
