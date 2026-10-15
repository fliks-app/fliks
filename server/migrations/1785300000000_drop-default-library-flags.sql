
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


      UPDATE "requests" r SET "libraryId" = sole."id"
      FROM (
        SELECT t."type", min(l."id") AS "id"
        FROM (VALUES ('movie'), ('series')) AS t("type")
        JOIN "libraries" l ON l."mediaTypes" @> to_jsonb(t."type")
        GROUP BY t."type"
      ) sole
      WHERE r."libraryId" IS NULL
        AND r."kind" = 'add'
        AND r."mediaType"::text = sole."type";


      DO $$
      DECLARE unresolved bigint;
      BEGIN
        SELECT count(*) INTO unresolved FROM "requests"
        WHERE "libraryId" IS NULL AND "kind" = 'add' AND "status" = 'pending';
        IF unresolved > 0 THEN
          RAISE WARNING '% pending request(s) have no library: no library accepts their media type', unresolved;
        END IF;
      END $$;

ALTER TABLE "libraries" DROP COLUMN IF EXISTS "isDefaultForMovies";

ALTER TABLE "libraries" DROP COLUMN IF EXISTS "isDefaultForSeries";
