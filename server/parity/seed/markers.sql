-- Parity Series A season 1 gets a third episode, plus a specials season; markers in both states.
INSERT INTO episodes ("episodeNumber", title, "hasFile", "seasonId") VALUES (3, 'Episode 3', true, 1);
INSERT INTO media_files ("mediaId", "episodeId", "relativePath", size, quality, language, "streamInfo")
  SELECT "mediaId", (SELECT max(id) FROM episodes), 'Season 01/Parity Series A - S01E03.mkv', size, quality, language, "streamInfo"
  FROM media_files WHERE "episodeId" = 1;
INSERT INTO seasons ("seasonNumber", "mediaId") VALUES (0, 18);
INSERT INTO episode_markers ("episodeId", type, "startSeconds", "endSeconds", confidence, manual) VALUES
 (1, 'intro', 10, 40, 0.8, false),
 (1, 'outro', 8.5, 9.5, 1, true),
 (2, 'intro', 12, 41, 1, true),
 (3, 'intro', 11, 39, 0.75, false);
UPDATE episode_markers SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01';
