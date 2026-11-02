-- Parity Series A season 1 gets a third episode, plus a specials season; markers in both states.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE contype = 'f' AND confrelid IN ('items'::regclass, 'item_parts'::regclass) AND pg_get_constraintdef(oid) NOT LIKE '%ON UPDATE%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON UPDATE CASCADE', r.tbl, r.conname, r.def);
  END LOOP;
END $$;
UPDATE items SET id = -id WHERE "groupId" IS NULL;
SELECT setval('items_id_seq', (SELECT max(id) FROM items));
INSERT INTO items ("number", title, "groupId", "mediaId", "editionId")
  VALUES (3, 'Episode 3', 1, 18, (SELECT id FROM editions WHERE "mediaId" = 18));
WITH f AS (
  INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, language, "streamInfo")
  SELECT "mediaId", "folderId", 'Parity Series A/Season 01/Parity Series A - S01E03.mkv', size, quality, language, "streamInfo"
  FROM media_files WHERE id = (SELECT "mediaFileId" FROM item_parts WHERE "itemId" = 1 LIMIT 1)
  RETURNING id, "mediaId")
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT (SELECT max(id) FROM items), id, "mediaId", 0 FROM f;
INSERT INTO item_groups ("number", "mediaId") VALUES (0, 18);
INSERT INTO item_markers ("itemId", kind, "startSeconds", "endSeconds", confidence, manual) VALUES
 (1, 'intro', 10, 40, 0.8, false),
 (1, 'outro', 8.5, 9.5, 1, true),
 (2, 'intro', 12, 41, 1, true),
 (3, 'intro', 11, 39, 0.75, false);
UPDATE item_markers SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01';
