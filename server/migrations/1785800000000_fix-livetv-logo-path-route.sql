UPDATE "livetv_channels"
       SET "logoPath" = regexp_replace("logoPath", '^/api/images/livetv/(\d+)$', '/api/livetv/channels/\1/logo')
       WHERE "logoPath" ~ '^/api/images/livetv/\d+$';
