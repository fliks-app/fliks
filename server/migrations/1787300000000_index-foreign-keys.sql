CREATE INDEX IF NOT EXISTS "IDX_seasons_mediaId" ON "seasons" ("mediaId");

CREATE INDEX IF NOT EXISTS "IDX_media_files_episodeId" ON "media_files" ("episodeId");

CREATE INDEX IF NOT EXISTS "IDX_media_libraryId" ON "media" ("libraryId");

CREATE INDEX IF NOT EXISTS "IDX_requests_userId" ON "requests" ("userId");

CREATE INDEX IF NOT EXISTS "IDX_requests_mediaId" ON "requests" ("mediaId");

CREATE INDEX IF NOT EXISTS "IDX_subtitle_files_episodeId" ON "subtitle_files" ("episodeId");
