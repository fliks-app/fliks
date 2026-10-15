DELETE FROM "subtitle_files"
       WHERE "codec" IS NULL AND "filePath" ~* '\.(sub|mks|smi|sami)$';
