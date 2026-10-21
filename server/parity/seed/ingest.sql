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
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, "tmdbId", overview, status, monitored, "folderName", genres, "libraryId") VALUES
 (101, '2026-01-01', '2026-01-01', 'Work Movie', 2020, 'movie', 5101, 'Work movie', 'released', true, 'Work Movie (2020)', '[]', 3),
 (102, '2026-01-01', '2026-01-01', 'Work Twin', 2020, 'movie', 5102, 'Shares the folder', 'released', true, 'Work Movie (2020)', '[]', 3),
 (103, '2026-01-01', '2026-01-01', 'Work Show', 2021, 'series', 5103, 'Work show', 'continuing', true, 'Work Show', '[]', 4),
 (104, '2026-01-01', '2026-01-01', 'Work Solo', 2019, 'movie', 5104, 'Own folder', 'released', true, 'Work Solo (2019)', '[]', 3);
INSERT INTO seasons (id, "createdAt", "updatedAt", "seasonNumber", monitored, "mediaId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, true, 103);
INSERT INTO episodes (id, "createdAt", "updatedAt", "episodeNumber", title, monitored, "hasFile", "seasonId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, 'Pilot', true, true, 101),
 (102, '2026-01-01', '2026-01-01', 2, 'Second', true, false, 101);
INSERT INTO media_files (id, "createdAt", "updatedAt", "mediaId", "episodeId", "relativePath", size, quality, language) VALUES
 (101, '2026-01-01', '2026-01-01', 101, NULL, 'Work Movie (2020).mkv', 73237, 'WEBDL-1080p', 'en'),
 (102, '2026-01-01', '2026-01-01', 103, 101, 'Season 01/Work Show - S01E01.mkv', 73237, 'WEBDL-1080p', 'en'),
 (103, '2026-01-01', '2026-01-01', 104, NULL, 'Work Solo (2019).mkv', 73237, 'WEBDL-1080p', 'en');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
