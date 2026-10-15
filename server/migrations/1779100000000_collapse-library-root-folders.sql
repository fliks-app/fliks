DO $$
DECLARE
  lib_id integer;
  parent "libraries"%ROWTYPE;
  rf record;
  new_lib_id integer;
  base_label text;
BEGIN
  FOR lib_id IN
    SELECT "libraryId"
      FROM "root_folders"
     WHERE "libraryId" IS NOT NULL
     GROUP BY "libraryId"
    HAVING COUNT(*) > 1
  LOOP
    SELECT * INTO parent FROM "libraries" WHERE id = lib_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    FOR rf IN
      SELECT src.id, src.path,
             (SELECT COUNT(*) FROM "media" m WHERE m."rootFolderId" = src.id)::int AS media_count
        FROM "root_folders" src
       WHERE src."libraryId" = lib_id
       ORDER BY media_count DESC, src.id ASC
       OFFSET 1
    LOOP
      SELECT COALESCE(
        (SELECT elem
           FROM unnest(string_to_array(rf.path, '/')) WITH ORDINALITY AS t(elem, n)
          WHERE elem <> ''
          ORDER BY n DESC
          LIMIT 1),
        'path-' || rf.id::text
      ) INTO base_label;

      INSERT INTO "libraries"
        ("name", "icon", "color", "mediaTypes", "preferredProvider",
         "stalledCleanupProfile", "defaultQualityProfileId",
         "defaultLanguageProfileId", "isDefaultForMovies",
         "isDefaultForSeries", "createdAt", "updatedAt")
      VALUES
        (parent.name || ' (' || base_label || ')', parent.icon, parent.color,
         parent."mediaTypes", parent."preferredProvider", parent."stalledCleanupProfile",
         parent."defaultQualityProfileId", parent."defaultLanguageProfileId",
         false, false, now(), now())
      RETURNING id INTO new_lib_id;

      UPDATE "root_folders" SET "libraryId" = new_lib_id WHERE id = rf.id;

      UPDATE "media" SET "libraryId" = new_lib_id WHERE "rootFolderId" = rf.id;

      INSERT INTO "library_user_access" ("libraryId", "userId", "createdAt", "updatedAt")
      SELECT new_lib_id, "userId", now(), now()
        FROM "library_user_access"
       WHERE "libraryId" = lib_id;

      INSERT INTO "role_default_libraries" ("roleId", "libraryId")
      SELECT "roleId", new_lib_id
        FROM "role_default_libraries"
       WHERE "libraryId" = lib_id
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END $$;

DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT COUNT(*) INTO orphan_count FROM "root_folders" WHERE "libraryId" IS NULL;
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Cannot enforce libraryId NOT NULL on root_folders — orphan rows exist. Resolve them manually before re-running the migration.';
  END IF;
END $$;

ALTER TABLE "root_folders" ALTER COLUMN "libraryId" SET NOT NULL;

ALTER TABLE "root_folders" ADD CONSTRAINT "UQ_root_folders_libraryId" UNIQUE ("libraryId");
