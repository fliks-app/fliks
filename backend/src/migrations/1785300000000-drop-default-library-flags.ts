import { MigrationInterface, QueryRunner } from 'typeorm';

/** A request's destination is resolved and stored when it is created. Pending
 *  rows predate that and would look for flags this migration drops. */
export class DropDefaultLibraryFlags1785300000000 implements MigrationInterface {
  name = 'DropDefaultLibraryFlags1785300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guarded: a dev database running `synchronize: true` has already dropped
    // the columns this reads.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'libraries' AND column_name = 'isDefaultForMovies'
        ) THEN
          UPDATE "requests" r SET "libraryId" = l."id"
          FROM "libraries" l
          WHERE r."libraryId" IS NULL
            AND r."kind" = 'add'
            AND ((r."mediaType" = 'movie' AND l."isDefaultForMovies")
              OR (r."mediaType" = 'series' AND l."isDefaultForSeries"));
        END IF;
      END $$;
    `);
    // No flag was set: the oldest library accepting the type takes the rows.
    // Arbitrary, but these predate the API that makes the caller choose, and
    // leaving them null only defers the problem to whoever approves them.
    await queryRunner.query(`
      UPDATE "requests" r SET "libraryId" = sole."id"
      FROM (
        SELECT t."type", min(l."id") AS "id"
        FROM (VALUES ('movie'), ('series')) AS t("type")
        JOIN "libraries" l ON l."mediaTypes" @> to_jsonb(t."type")
        GROUP BY t."type"
      ) sole
      WHERE r."libraryId" IS NULL
        AND r."kind" = 'add'
        AND r."mediaType"::text = sole."type"
    `);
    // Only rows whose media type no library accepts at all survive both passes.
    await queryRunner.query(`
      DO $$
      DECLARE unresolved bigint;
      BEGIN
        SELECT count(*) INTO unresolved FROM "requests"
        WHERE "libraryId" IS NULL AND "kind" = 'add' AND "status" = 'pending';
        IF unresolved > 0 THEN
          RAISE WARNING '% pending request(s) have no library: no library accepts their media type', unresolved;
        END IF;
      END $$;
    `);
    await queryRunner.query(
      `ALTER TABLE "libraries" DROP COLUMN IF EXISTS "isDefaultForMovies"`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" DROP COLUMN IF EXISTS "isDefaultForSeries"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "isDefaultForMovies" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "isDefaultForSeries" boolean NOT NULL DEFAULT false`,
    );
  }
}
