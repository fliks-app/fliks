-- Parity seed delta "ingest" (docs/spec/ingest.md, media-write.md Vectors/parity), on top of base.sql.
-- Writes only under /tmp/fliks-parity/s5-ingest/work (scenario `fs` rebuilds it): never the base media tree.
-- readonly becomes an editor of library 1 and the work movies library only.
UPDATE roles SET permissions = '["media.read","media.create","media.edit","media.delete","livetv.read"]' WHERE id = 3;
INSERT INTO quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items) VALUES
 (1, '2026-01-01', '2026-01-01', 'Parity HD', 18, '[]');
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path) VALUES
 (3, '2026-01-01', '2026-01-01', 'Work Movies', 'film', '#111111', '["movie"]', '/tmp/fliks-parity/s5-ingest/work/movies'),
 (4, '2026-01-01', '2026-01-01', 'Work Series', 'tv', '#222222', '["series"]', '/tmp/fliks-parity/s5-ingest/work/series'),
 (5, '2026-01-01', '2026-01-01', 'Pathless', 'film', '#333333', '["movie"]', NULL);
INSERT INTO library_user_access ("createdAt", "updatedAt", "libraryId", "userId") VALUES ('2026-01-01', '2026-01-01', 3, 3);
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, overview, status, monitored, "folderName", genres, "libraryId") VALUES
 (101, '2026-01-01', '2026-01-01', 'Work Movie', 2020, 'movie', 'Work movie', 'released', true, 'Work Movie (2020)', '[]', 3),
 (102, '2026-01-01', '2026-01-01', 'Work Twin', 2020, 'movie', 'Shares the folder', 'released', true, 'Work Movie (2020)', '[]', 3),
 (103, '2026-01-01', '2026-01-01', 'Work Show', 2021, 'series', 'Work show', 'continuing', true, 'Work Show', '[]', 4),
 (104, '2026-01-01', '2026-01-01', 'Work Solo', 2019, 'movie', 'Own folder', 'released', true, 'Work Solo (2019)', '[]', 3);
INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES
 (101, 'movie', 'tmdb', '5101'),
 (102, 'movie', 'tmdb', '5102'),
 (103, 'series', 'tmdb', '5103'),
 (104, 'movie', 'tmdb', '5104');
INSERT INTO editions ("mediaId", family)
  SELECT id, 'video' FROM media m WHERE NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id) ORDER BY id;
INSERT INTO wants ("mediaId", family)
  SELECT id, 'video' FROM media m WHERE NOT EXISTS (SELECT 1 FROM wants w WHERE w."mediaId" = m.id) ORDER BY id;
INSERT INTO item_groups (id, "createdAt", "updatedAt", "number", monitored, "mediaId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, true, 103);
INSERT INTO items (id, "createdAt", "updatedAt", "number", title, monitored, "groupId", "mediaId", "editionId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, 'Pilot', true, 101, 103, (SELECT id FROM editions WHERE "mediaId" = 103)),
 (102, '2026-01-01', '2026-01-01', 2, 'Second', true, 101, 103, (SELECT id FROM editions WHERE "mediaId" = 103));
INSERT INTO items ("mediaId", "editionId", monitored)
  SELECT m.id, e.id, true FROM media m JOIN editions e ON e."mediaId" = m.id
  WHERE m.type = 'movie' AND NOT EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id) ORDER BY m.id;
INSERT INTO media_files (id, "createdAt", "updatedAt", "mediaId", "relativePath", size, quality, language) VALUES
 (101, '2026-01-01', '2026-01-01', 101, 'Work Movie (2020).mkv', 73237, 'WEBDL-1080p', 'en'),
 (102, '2026-01-01', '2026-01-01', 103, 'Season 01/Work Show - S01E01.mkv', 73237, 'WEBDL-1080p', 'en'),
 (103, '2026-01-01', '2026-01-01', 104, 'Work Solo (2019).mkv', 73237, 'WEBDL-1080p', 'en');
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
  SELECT COALESCE(v.item, i.id), f.id, f."mediaId", 0 FROM media_files f
  JOIN (VALUES (101, NULL::int), (102, 101), (103, NULL::int)) AS v(file, item) ON v.file = f.id
  LEFT JOIN items i ON i."mediaId" = f."mediaId" AND i."groupId" IS NULL;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
