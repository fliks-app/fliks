ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "path" varchar;

ALTER TABLE "libraries" ADD COLUMN IF NOT EXISTS "label" varchar;

UPDATE "libraries" lib
          SET "path"  = rf.path,
              "label" = rf.label
         FROM "root_folders" rf
        WHERE rf."libraryId" = lib.id;

ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "FK_ecd8a0e3718ba485b1cfffd5999";

ALTER TABLE "media" DROP COLUMN IF EXISTS "rootFolderId";

ALTER TABLE "requests" DROP CONSTRAINT IF EXISTS "FK_11390ba18a01b3f758bd13dd7b0";

ALTER TABLE "requests" DROP COLUMN IF EXISTS "rootFolderId";

DROP TABLE IF EXISTS "root_folders";
