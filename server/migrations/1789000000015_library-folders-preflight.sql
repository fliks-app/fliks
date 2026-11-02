-- Runs before every other 6.0.0 migration: fixes what the data lets fix and refuses the rest, so a
-- refusal leaves the database untouched and 5.x still runs. `1789000000195` moves the paths into folders.
CREATE FUNCTION pg_temp.lf_norm(text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT regexp_replace(regexp_replace($1, '/{2,}', '/', 'g'), '(.)/+$', '\1') $$;
-- The shape `CK_media_files_relative_path` refuses: absolute, a . or .. segment, an empty segment.
CREATE FUNCTION pg_temp.lf_bad(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS
$$ SELECT $1 ~ '(^/|(^|/)\.{1,2}(/|$)|//)' $$;

DO $$
DECLARE n bigint; ids text; stmts text; r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'libraries' AND column_name = 'path') THEN
    RETURN;
  END IF;

  -- Files of no media would leave `folderId` NULL.
  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id") FILTER (WHERE "rn" <= 100),
         string_agg(format('UPDATE media_files SET "mediaId" = <media id> WHERE id = %s;', "id"), ' ' ORDER BY "id") FILTER (WHERE "rn" <= 100)
    INTO n, ids, stmts
    FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS "rn" FROM "media_files" WHERE "mediaId" IS NULL) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media file(s) belong to no media (first ids: %; re-run until clean). The server cannot start until each is attached or removed: run in psql % or, to drop the rows (this cascades to their playback_states and subtitle_files; the files on disk are untouched) DELETE FROM media_files WHERE id IN (%); then restart', n, ids, stmts, ids;
  END IF;

  -- Library paths as `assignPath` stores them; a directory belongs to one library.
  ALTER TABLE "libraries" DISABLE TRIGGER set_updated_at;
  UPDATE "libraries" SET "path" = pg_temp.lf_norm("path")
   WHERE COALESCE("path", '') <> '' AND "path" <> pg_temp.lf_norm("path");
  ALTER TABLE "libraries" ENABLE TRIGGER set_updated_at;
  SELECT count(*), string_agg(format('libraries %s share %s: %s', "libs", "path", "sqls"), '; ' ORDER BY "first") INTO n, ids
    FROM (SELECT "path", min("id") AS "first", string_agg("id"::text, ', ' ORDER BY "id") AS "libs",
                 string_agg(format('UPDATE libraries SET path = ''<directory>'' WHERE id = %s;', "id"), ' ' ORDER BY "id") AS "sqls"
            FROM "libraries" WHERE COALESCE("path", '') <> '' GROUP BY "path" HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % directory(ies) belong to several libraries. The server cannot start until each library has its own: run in psql, then restart: %', n, ids;
  END IF;

  -- A media outside every library that owns files joins the one library that takes its type and has a path.
  CREATE TEMP TABLE "lf_orphans" ON COMMIT DROP AS
  SELECT m."id" AS "media", count(l."id") AS "cnt", min(l."id") AS "lib"
    FROM "media" m LEFT JOIN "libraries" l ON COALESCE(l."path", '') <> '' AND l."mediaTypes" @> to_jsonb(m."type"::text)
   WHERE m."libraryId" IS NULL AND EXISTS (SELECT 1 FROM "media_files" f WHERE f."mediaId" = m."id")
   GROUP BY m."id";
  SELECT count(*), string_agg("media"::text, ', ' ORDER BY "media") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "media", row_number() OVER (ORDER BY "media") AS "rn" FROM "lf_orphans" WHERE "cnt" <> 1) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media own files but belong to no library and no single library takes them (first ids: %; re-run until clean). The server cannot start until each is in a library: run in psql UPDATE media SET "libraryId" = <library id> WHERE id IN (%); then restart', n, ids, ids;
  END IF;
  ALTER TABLE "media" DISABLE TRIGGER set_updated_at;
  UPDATE "media" m SET "libraryId" = o."lib" FROM "lf_orphans" o WHERE o."media" = m."id";
  ALTER TABLE "media" ENABLE TRIGGER set_updated_at;

  -- Files of a library without a path.
  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id"),
         string_agg(format('UPDATE libraries SET path = ''<directory>'' WHERE id = %s;', "id"), ' ' ORDER BY "id") INTO n, ids, stmts
    FROM "libraries" l
   WHERE COALESCE(l."path", '') = '' AND EXISTS (SELECT 1 FROM "media_files" f JOIN "media" m ON m."id" = f."mediaId" WHERE m."libraryId" = l."id");
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: library(ies) % hold files but have no path. The server cannot start until each has its own directory: run in psql %; then restart', ids, stmts;
  END IF;

  -- The path each file will have under its folder root.
  CREATE TEMP TABLE "lf_moved" ON COMMIT DROP AS
  SELECT f."id", f."mediaId" AS "media", l."id" AS "lib",
         CASE WHEN f."relativePath" = '' THEN NULL
              WHEN f."relativePath" LIKE '/%'
                THEN CASE WHEN left(f."relativePath", length(rtrim(l."path", '/')) + 1) = rtrim(l."path", '/') || '/'
                          THEN substr(f."relativePath", length(rtrim(l."path", '/')) + 2) END
              WHEN COALESCE(m."folderName", '') = '' THEN f."relativePath"
              ELSE m."folderName" || '/' || f."relativePath" END AS "rel",
         f."relativePath" NOT LIKE '/%' AND f."relativePath" <> '' AND COALESCE(m."folderName", '') <> ''
           AND pg_temp.lf_bad(m."folderName" || '/') AS "bad_folder"
    FROM "media_files" f JOIN "media" m ON m."id" = f."mediaId" JOIN "libraries" l ON l."id" = m."libraryId";

  SELECT count(*), string_agg("media"::text, ', ' ORDER BY "media") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "media", row_number() OVER (ORDER BY "media") AS "rn" FROM (SELECT DISTINCT "media" FROM "lf_moved" WHERE "bad_folder") d) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media have a folderName that is absolute, or holds a ., .. or empty segment (first ids: %; re-run until clean). The server cannot start until they are corrected: run in psql UPDATE media SET "folderName" = ''<directory name under the library path>'' WHERE id = <id>; for each, then restart', n, ids;
  END IF;

  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id") FILTER (WHERE "rn" <= 100) INTO n, ids
    FROM (SELECT "id", row_number() OVER (ORDER BY "id") AS "rn" FROM "lf_moved"
           WHERE "rel" IS NULL OR "rel" = '' OR pg_temp.lf_bad("rel")) x;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media file(s) have a relativePath that is empty, outside its library, or holds a ., .. or empty segment (first ids: %; re-run until clean). The server cannot start until they are corrected: run in psql UPDATE media_files SET "relativePath" = ''<path relative to the media folder>'' WHERE id = <id>; for each, then restart', n, ids;
  END IF;

  -- The lowest id of a path stays; the others are listed with the media they belong to.
  SELECT count(*), string_agg(format('file %s (media %s) duplicates file %s (media %s): UPDATE playback_states SET "mediaFileId" = %s WHERE "mediaFileId" = %s; UPDATE subtitle_files SET "mediaFileId" = %s WHERE "mediaFileId" = %s; DELETE FROM media_files WHERE id = %s;',
                              "id", "media", "kept", "kept_media", "kept", "id", "kept", "id", "id"), ' ' ORDER BY "id") FILTER (WHERE "rn" <= 100)
    INTO n, stmts
    FROM (SELECT *, row_number() OVER (ORDER BY "id") AS "rn"
            FROM (SELECT "id", "media", first_value("id") OVER w AS "kept", first_value("media") OVER w AS "kept_media",
                         row_number() OVER w AS "k"
                    FROM "lf_moved" WINDOW w AS (PARTITION BY "lib", "rel" ORDER BY "id")) y WHERE "k" > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION 'library_folders: % media file(s) would share one path in their folder with a lower-id file (first 100 listed; re-run until clean). The server cannot start until each is merged: a bare DELETE cascades to the file''s playback_states, subtitle_files and scan, so re-point them first, and swap the two ids to keep the other file (the files on disk are untouched). Run in psql: %; then restart', n, stmts;
  END IF;
END $$;

DROP FUNCTION pg_temp.lf_bad(text);
DROP FUNCTION pg_temp.lf_norm(text);
