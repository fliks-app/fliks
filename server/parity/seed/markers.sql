-- Parity Series A season 1 gets a third episode, plus a specials season; markers in both states.
ALTER TABLE item_parts DROP CONSTRAINT "FK_item_parts_item";
UPDATE items SET id = -id WHERE "groupId" IS NULL;
UPDATE item_parts SET "itemId" = -"itemId" WHERE "itemId" IN (SELECT -id FROM items WHERE "groupId" IS NULL);
ALTER TABLE item_parts ADD CONSTRAINT "FK_item_parts_item" FOREIGN KEY ("itemId", "mediaId")
  REFERENCES items (id, "mediaId") ON DELETE CASCADE;
SELECT setval('items_id_seq', (SELECT max(id) FROM items));
INSERT INTO items ("number", title, "groupId", "mediaId", "editionId")
  VALUES (3, 'Episode 3', 1, 18, (SELECT id FROM editions WHERE "mediaId" = 18));
WITH f AS (
  INSERT INTO media_files ("mediaId", "relativePath", size, quality, language, "streamInfo")
  SELECT "mediaId", 'Season 01/Parity Series A - S01E03.mkv', size, quality, language, "streamInfo"
  FROM media_files WHERE id = (SELECT "mediaFileId" FROM item_parts WHERE "itemId" = 1 LIMIT 1)
  RETURNING id, "mediaId")
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId") SELECT (SELECT max(id) FROM items), id, "mediaId" FROM f;
INSERT INTO item_groups ("number", "mediaId") VALUES (0, 18);
INSERT INTO item_markers ("itemId", kind, "startSeconds", "endSeconds", confidence, manual) VALUES
 (1, 'intro', 10, 40, 0.8, false),
 (1, 'outro', 8.5, 9.5, 1, true),
 (2, 'intro', 12, 41, 1, true),
 (3, 'intro', 11, 39, 0.75, false);
UPDATE item_markers SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01';
