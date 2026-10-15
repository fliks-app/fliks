UPDATE "subtitle_files"
          SET "score" = 100,
              "synced" = true
        WHERE "providerType" = 'disk'
          AND "score" = 0;
