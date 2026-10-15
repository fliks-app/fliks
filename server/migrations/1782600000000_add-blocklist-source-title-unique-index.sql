
      DELETE FROM "blocklist" b
      USING "blocklist" b2
      WHERE LOWER(b."sourceTitle") = LOWER(b2."sourceTitle")
        AND b.id > b2.id;

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_blocklist_sourceTitle_lower" ON "blocklist" (LOWER("sourceTitle"));
