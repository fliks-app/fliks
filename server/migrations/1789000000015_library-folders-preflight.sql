-- Runs before every other 6.0.0 migration: fixes what the data lets fix and refuses the rest, so a
-- refusal leaves the database untouched and 5.x still runs. `1789000000195` moves the paths into folders.
CREATE FUNCTION pg_temp.lf_norm(text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT regexp_replace(regexp_replace($1, '/{2,}', '/', 'g'), '(.)/+$', '\1') $$;

DO $$
DECLARE n bigint; ids text; r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'path') THEN
    RETURN;
  END IF;

  -- Library paths as `assignPath` stores them. Libraries naming one normalised path: the one already
  -- written that way keeps it, else the lowest id; the others keep what they hold.
  ALTER TABLE "libraries" DISABLE TRIGGER set_updated_at;
  WITH c AS (SELECT "id", "path", pg_temp.lf_norm("path") AS "np" FROM "libraries" WHERE COALESCE("path", '') <> ''),
       w AS (SELECT DISTINCT ON ("np") "np", "id" FROM c ORDER BY "np", ("path" = "np") DESC, "id")
  UPDATE "libraries" l SET "path" = c."np" FROM c JOIN w ON w."np" = c."np" AND w."id" = c."id"
   WHERE l."id" = c."id" AND l."path" <> c."np";
  ALTER TABLE "libraries" ENABLE TRIGGER set_updated_at;
  FOR r IN SELECT string_agg("id"::text, ', ' ORDER BY "id") AS "libs", pg_temp.lf_norm("path") AS "np"
             FROM "libraries" WHERE COALESCE("path", '') <> '' GROUP BY pg_temp.lf_norm("path") HAVING count(*) > 1 LOOP
    RAISE NOTICE 'library_folders: libraries % name one directory (%); each keeps its own path', r."libs", r."np";
  END LOOP;

  -- A media outside every library that owns files joins the one library that takes its type and has a path.
  CREATE TEMP TABLE "lf_orphans" ON COMMIT DROP AS
  SELECT m."id" AS "media", count(l."id") AS "cnt", min(l."id") AS "lib"
    FROM "media" m LEFT JOIN "libraries" l ON COALESCE(l."path", '') <> '' AND l."mediaTypes" @> to_jsonb(m."type"::text)
   WHERE m."libraryId" IS NULL AND EXISTS (SELECT 1 FROM "media_files" f WHERE f."mediaId" = m."id")
   GROUP BY m."id";
  SELECT count(*), string_agg("media"::text, ', ' ORDER BY "media") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "media", row_number() OVER (ORDER BY "media") AS "rn" FROM "lf_orphans" WHERE "cnt" <> 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media own files but belong to no library and no single library takes them (first ids: %). The server cannot start until each is in a library: run in psql UPDATE media SET "libraryId" = <library id> WHERE id IN (%); then restart', n, ids, ids;
  END IF;
  ALTER TABLE "media" DISABLE TRIGGER set_updated_at;
  UPDATE "media" m SET "libraryId" = o."lib" FROM "lf_orphans" o WHERE o."media" = m."id";
  ALTER TABLE "media" ENABLE TRIGGER set_updated_at;

  -- Files of a library without a path.
  SELECT count(DISTINCT l."id"), string_agg(DISTINCT l."id"::text, ', ') INTO n, ids
    FROM "media_files" f JOIN "media" m ON m."id" = f."mediaId" JOIN "libraries" l ON l."id" = m."libraryId"
   WHERE COALESCE(l."path", '') = '';
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: library(ies) % hold files but have no path. The server cannot start until they have one: run in psql UPDATE libraries SET path = ''<directory>'' WHERE id IN (%); then restart', ids, ids;
  END IF;

  -- The path each file will have under its folder root.
  CREATE TEMP TABLE "lf_moved" ON COMMIT DROP AS
  SELECT f."id", l."id" AS "lib",
         CASE WHEN f."relativePath" = '' THEN NULL
              WHEN f."relativePath" LIKE '/%'
                THEN CASE WHEN left(f."relativePath", length(rtrim(l."path", '/')) + 1) = rtrim(l."path", '/') || '/'
                          THEN substr(f."relativePath", length(rtrim(l."path", '/')) + 2) END
              WHEN COALESCE(m."folderName", '') = '' THEN f."relativePath"
              ELSE m."folderName" || '/' || f."relativePath" END AS "rel"
    FROM "media_files" f JOIN "media" m ON m."id" = f."mediaId" JOIN "libraries" l ON l."id" = m."libraryId";

  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS "rn" FROM "lf_moved"
           WHERE "rel" IS NULL OR "rel" = '' OR "rel" ~ '(^/|(^|/)\.\.(/|$)|//)') x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media file(s) have a relativePath that is empty, outside its library, or holds a .. or empty segment (first ids: %). The server cannot start until they are corrected: run in psql UPDATE media_files SET "relativePath" = ''<path relative to the media folder>'' WHERE id = <id>; for each, then restart', n, ids;
  END IF;

  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS "rn" FROM
           (SELECT "id", row_number() OVER (PARTITION BY "lib", "rel" ORDER BY "id") AS "k" FROM "lf_moved") y WHERE "k" > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media file(s) would share one path in their folder with a lower-id file. The server cannot start until they are removed: run in psql DELETE FROM media_files WHERE id IN (%); then restart (the lowest id of each path stays; the files on disk are untouched)', n, ids;
  END IF;
END $$;

DROP FUNCTION pg_temp.lf_norm(text);
