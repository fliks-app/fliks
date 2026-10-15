DELETE FROM "media_files"
       WHERE "episodeId" IS NULL
         AND "mediaId" IN (SELECT "id" FROM "media" WHERE "type" = 'series');
