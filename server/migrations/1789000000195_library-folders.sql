CREATE TABLE "library_folders" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "libraryId" integer NOT NULL,
  "path" text NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  CONSTRAINT "FK_library_folders_library" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE CASCADE,
  CONSTRAINT "UQ_library_folders_path" UNIQUE ("path"),
  CONSTRAINT "CK_library_folders_path" CHECK ("path" <> ''),
  CONSTRAINT "CK_library_folders_position" CHECK ("position" >= 0)
);
CREATE INDEX "IDX_library_folders_libraryId" ON "library_folders" ("libraryId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "library_folders" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE VIEW "library_default_folders" AS
SELECT DISTINCT ON ("libraryId") "libraryId", "id" AS "folderId", "path"
  FROM "library_folders" ORDER BY "libraryId", "position", "id";

-- The whitespace the readers trim (JS `trim()`: Unicode White_Space without U+0085, plus U+FEFF).
CREATE FUNCTION pg_temp.js_trim(text) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT btrim($1, E'\t\n\x0b\f\r                  　﻿') $$;

-- The preflight (`1789000000015`) left every path normalised and every file placeable.
INSERT INTO "library_folders" ("libraryId", "path") SELECT "id", "path" FROM "libraries" WHERE COALESCE("path", '') <> '' ORDER BY "id";

CREATE TEMP TABLE "lf_moved" ON COMMIT DROP AS
SELECT f."id", lf."id" AS "folder",
       CASE WHEN f."relativePath" LIKE '/%'
              THEN substr(f."relativePath", length(rtrim(lf."path", '/')) + 2)
            WHEN COALESCE(m."folderName", '') = '' THEN f."relativePath"
            ELSE m."folderName" || '/' || f."relativePath" END AS "rel"
  FROM "media_files" f JOIN "media" m ON m."id" = f."mediaId" JOIN "library_folders" lf ON lf."libraryId" = m."libraryId";

ALTER TABLE "media_files" ADD COLUMN "folderId" integer;
ALTER TABLE "media_files" DISABLE TRIGGER set_updated_at;
UPDATE "media_files" f SET "folderId" = x."folder", "relativePath" = x."rel" FROM "lf_moved" x WHERE x."id" = f."id";
ALTER TABLE "media_files" ENABLE TRIGGER set_updated_at;
ALTER TABLE "media_files"
  ALTER COLUMN "folderId" SET NOT NULL,
  ADD CONSTRAINT "FK_media_files_folder" FOREIGN KEY ("folderId") REFERENCES "library_folders"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "CK_media_files_relative_path" CHECK ("relativePath" <> '' AND "relativePath" !~ '(^/|(^|/)\.{1,2}(/|$)|//)'),
  DROP CONSTRAINT "UQ_89a6bf94332e9f2715c4d06b36c",
  ADD CONSTRAINT "UQ_media_files_folder_path" UNIQUE ("folderId", "relativePath");
CREATE INDEX "IDX_media_files_mediaId" ON "media_files" ("mediaId");

ALTER TABLE "subtitle_files" DISABLE TRIGGER set_updated_at;
UPDATE "subtitle_files" sf SET "filePath" = m."folderName" || '/' || pg_temp.js_trim(sf."filePath")
  FROM "media" m
 WHERE m."id" = sf."mediaId" AND COALESCE(m."folderName", '') <> ''
   AND pg_temp.js_trim(COALESCE(sf."filePath", '')) <> '' AND pg_temp.js_trim(sf."filePath") NOT LIKE '/%';
ALTER TABLE "subtitle_files" ENABLE TRIGGER set_updated_at;

DROP FUNCTION pg_temp.js_trim(text);

ALTER TABLE "wants" ADD COLUMN "folderId" integer,
  ADD CONSTRAINT "FK_wants_folder" FOREIGN KEY ("folderId") REFERENCES "library_folders"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_wants_folderId" ON "wants" ("folderId");

ALTER TABLE "libraries" DROP COLUMN "path", DROP COLUMN "label";
