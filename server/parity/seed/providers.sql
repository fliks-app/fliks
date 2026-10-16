-- Parity seed delta "providers" (docs/spec/media-write.md Vectors/parity), applied on top of base.sql:
-- provider-backed import, refresh, identify and season overrides against external/stub.py fixtures.
ALTER TABLE libraries DISABLE TRIGGER set_updated_at;
UPDATE libraries SET "preferredProvider" = 'tvdb' WHERE id = 2;
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path, "metadataLanguage", "metadataRegion") VALUES
 (6, '2026-01-01', '2026-01-01', 'Plain Series', 'tv', '#444444', '["series"]', '/tmp/fliks-parity/providers/series', NULL, NULL),
 (7, '2026-01-01', '2026-01-01', 'French Movies', 'film', '#555555', '["movie"]', '/tmp/fliks-parity/providers/movies-fr', 'fr', 'FR'),
 (8, '2026-01-01', '2026-01-01', 'Provider Movies', 'film', '#666666', '["movie"]', '/tmp/fliks-parity/providers/movies', NULL, NULL);
ALTER TABLE libraries ENABLE TRIGGER set_updated_at;
UPDATE media SET "tmdbId" = NULL WHERE "tmdbId" IN (1001, 1002, 1003, 2000, 1396);
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, "tmdbId", "tvdbId", "imdbId", overview, status, monitored, "folderName", genres, "libraryId", "preferredProvider") VALUES
 (201, '2026-01-01', '2026-01-01', 'Old Title', 1990, 'movie', 1001, NULL, NULL, 'old', 'released', true, 'Old Title (1990)', '["Old"]', 8, NULL),
 (202, '2026-01-01', '2026-01-01', 'Seasons Show', 2008, 'series', 2000, 81190, NULL, 'old', 'continuing', true, 'Seasons Show', '[]', 6, NULL),
 (203, '2026-01-01', '2026-01-01', 'Imdb Only', 2008, 'series', NULL, NULL, 'tt0903747', 'old', 'continuing', true, 'Imdb Only', '[]', 6, NULL),
 (204, '2026-01-01', '2026-01-01', 'Tvdb Only', 2008, 'series', NULL, 81190, NULL, 'old', 'continuing', true, 'Tvdb Only', '[]', 6, 'tmdb'),
 (206, '2026-01-01', '2026-01-01', 'Strict Fail', 1999, 'movie', 1003, NULL, NULL, 'old', 'released', true, 'Strict Fail (1999)', '[]', 8, 'tvdb');
INSERT INTO seasons (id, "createdAt", "updatedAt", "seasonNumber", monitored, "mediaId", "preferredProvider") VALUES
 (201, '2026-01-01', '2026-01-01', 0, false, 202, NULL),
 (202, '2026-01-01', '2026-01-01', 1, true, 202, 'tvdb'),
 (203, '2026-01-01', '2026-01-01', 2, true, 202, NULL);
INSERT INTO episodes (id, "createdAt", "updatedAt", "episodeNumber", title, monitored, "hasFile", "seasonId") VALUES
 (201, '2026-01-01', '2026-01-01', 1, 'Old Ep 1', true, false, 202),
 (202, '2026-01-01', '2026-01-01', 9, 'Gone', true, false, 202);
INSERT INTO persons (id, "createdAt", "updatedAt", "tmdbId", name, biography, "knownForDepartment", departments, "metadataRefreshedAt", provider) VALUES
 (201, '2026-01-01', '2026-01-01', 102, 'Claude Old Name', 'Old bio', 'Acting', '["Writing"]', now() - interval '30 days', 'tmdb');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
