ALTER TABLE "requests" ADD COLUMN "folderId" integer,
  ADD CONSTRAINT "FK_requests_folder" FOREIGN KEY ("folderId") REFERENCES "library_folders"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_requests_folderId" ON "requests" ("folderId");

-- A want names its folder: the one holding the media's files, else the library's default folder.
ALTER TABLE "wants" DISABLE TRIGGER set_updated_at;
UPDATE "wants" w SET "folderId" = COALESCE(
  (SELECT mf."folderId" FROM "media_files" mf JOIN "library_folders" lf ON lf."id" = mf."folderId"
     WHERE mf."mediaId" = w."mediaId" AND lf."libraryId" = m."libraryId" ORDER BY mf."id" LIMIT 1),
  (SELECT df."folderId" FROM "library_default_folders" df WHERE df."libraryId" = m."libraryId"))
FROM "media" m WHERE m."id" = w."mediaId" AND w."folderId" IS NULL;
ALTER TABLE "wants" ENABLE TRIGGER set_updated_at;

-- The folder a media's new files go to: its video want's folder when it is one of the media's library, else the default.
CREATE VIEW "media_target_folders" AS
SELECT m."id" AS "mediaId", COALESCE(wf."id", df."folderId") AS "folderId", COALESCE(wf."path", df."path") AS "path"
  FROM "media" m
  LEFT JOIN "wants" w ON w."mediaId" = m."id" AND w."family" = 'video' AND w."language" IS NULL
  LEFT JOIN "library_folders" wf ON wf."id" = w."folderId" AND wf."libraryId" = m."libraryId"
  LEFT JOIN "library_default_folders" df ON df."libraryId" = m."libraryId";
