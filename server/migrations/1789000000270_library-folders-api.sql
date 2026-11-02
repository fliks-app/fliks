ALTER TABLE "requests" ADD COLUMN "folderId" integer,
  ADD CONSTRAINT "FK_requests_folder" FOREIGN KEY ("folderId") REFERENCES "library_folders"("id") ON DELETE SET NULL;
CREATE INDEX "IDX_requests_folderId" ON "requests" ("folderId");

-- The folder a media's new files go to: its video want's folder when it is one of the media's library, else the default.
CREATE VIEW "media_target_folders" AS
SELECT m."id" AS "mediaId", COALESCE(wf."id", df."folderId") AS "folderId", COALESCE(wf."path", df."path") AS "path"
  FROM "media" m
  LEFT JOIN "wants" w ON w."mediaId" = m."id" AND w."family" = 'video'
  LEFT JOIN "library_folders" wf ON wf."id" = w."folderId" AND wf."libraryId" = m."libraryId"
  LEFT JOIN "library_default_folders" df ON df."libraryId" = m."libraryId";
