-- Parity seed delta "providers" (docs/spec/media-write.md Vectors/parity), applied on top of base.sql:
-- provider-backed import, refresh, identify and season overrides against external/stub.py fixtures.
-- base.sql predates the persons search vector migration; Rust relies on its trigger.
CREATE OR REPLACE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.name);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS persons_search_vector ON persons;
CREATE TRIGGER persons_search_vector BEFORE INSERT OR UPDATE OF name
  ON persons FOR EACH ROW EXECUTE FUNCTION persons_search_vector_update();
ALTER TABLE libraries DISABLE TRIGGER set_updated_at;
UPDATE libraries SET "preferredProvider" = 'tvdb' WHERE id = 2;
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path, "metadataLanguage", "metadataRegion") VALUES
 (6, '2026-01-01', '2026-01-01', 'Plain Series', 'tv', '#444444', '["series"]', '/tmp/fliks-parity/providers/series', NULL, NULL),
 (7, '2026-01-01', '2026-01-01', 'French Movies', 'film', '#555555', '["movie"]', '/tmp/fliks-parity/providers/movies-fr', 'fr', 'FR'),
 (8, '2026-01-01', '2026-01-01', 'Provider Movies', 'film', '#666666', '["movie"]', '/tmp/fliks-parity/providers/movies', NULL, NULL),
 (9, '2026-01-01', '2026-01-01', 'Rescan Series', 'tv', '#888888', '["series"]', '/tmp/fliks-parity/s5-ingest/work/provider-series', NULL, NULL);
ALTER TABLE libraries ENABLE TRIGGER set_updated_at;
DELETE FROM media_external_ids WHERE provider = 'tmdb' AND value IN ('1001', '1002', '1003', '1004', '2000', '1396');
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, overview, status, monitored, "folderName", genres, "libraryId", "preferredProvider") VALUES
 (201, '2026-01-01', '2026-01-01', 'Old Title', 1990, 'movie', 'old', 'released', true, 'Old Title (1990)', '["Old"]', 8, NULL),
 (202, '2026-01-01', '2026-01-01', 'Seasons Show', 2008, 'series', 'old', 'continuing', true, 'Seasons Show', '[]', 6, NULL),
 (203, '2026-01-01', '2026-01-01', 'Imdb Only', 2008, 'series', 'old', 'continuing', true, 'Imdb Only', '[]', 6, NULL),
 (204, '2026-01-01', '2026-01-01', 'Tvdb Only', 2008, 'series', 'old', 'continuing', true, 'Tvdb Only', '[]', 6, 'tmdb'),
 (206, '2026-01-01', '2026-01-01', 'Strict Fail', 1999, 'movie', 'old', 'released', true, 'Strict Fail (1999)', '[]', 8, 'tvdb');
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, overview, status, monitored, "folderName", genres, "libraryId", "preferredProvider") VALUES
 (207, '2026-01-01', '2026-01-01', 'Pref Fallback', 2008, 'series', 'old', 'continuing', true, 'Pref Fallback', '[]', 2, NULL),
 (208, '2026-01-01', '2026-01-01', 'Pref Writes Back', 2008, 'series', 'old', 'continuing', true, 'Pref Writes Back', '[]', 2, NULL),
 (209, '2026-01-01', '2026-01-01', 'Person Both', 1999, 'movie', 'old', 'released', true, 'Person Both (1999)', '[]', 8, NULL),
 (210, '2026-01-01', '2026-01-01', 'Rescan Show', 2008, 'series', 'old', 'continuing', true, 'Rescan Show', '[]', 9, NULL);
INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES
 (201, 'movie', 'tmdb', '1001'),
 (202, 'series', 'tmdb', '2000'),
 (202, 'series', 'tvdb', '81190'),
 (203, 'series', 'imdb', 'tt0903747'),
 (204, 'series', 'tvdb', '81190'),
 (206, 'movie', 'tmdb', '1003'),
 (207, 'series', 'tmdb', '3002'),
 (208, 'series', 'tmdb', '3003'),
 (209, 'movie', 'tmdb', '1004'),
 (210, 'series', 'tmdb', '3004');
INSERT INTO editions ("mediaId", family)
  SELECT id, 'video' FROM media m WHERE NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id) ORDER BY id;
INSERT INTO item_groups (id, "createdAt", "updatedAt", "number", monitored, "mediaId", "preferredProvider") VALUES
 (201, '2026-01-01', '2026-01-01', 0, false, 202, NULL),
 (202, '2026-01-01', '2026-01-01', 1, true, 202, 'tvdb'),
 (203, '2026-01-01', '2026-01-01', 2, true, 202, NULL);
INSERT INTO items (id, "createdAt", "updatedAt", "number", title, monitored, "hasFile", "groupId", "mediaId", "editionId") VALUES
 (201, '2026-01-01', '2026-01-01', 1, 'Old Ep 1', true, false, 202, 202, (SELECT id FROM editions WHERE "mediaId" = 202)),
 (202, '2026-01-01', '2026-01-01', 9, 'Gone', true, false, 202, 202, (SELECT id FROM editions WHERE "mediaId" = 202));
INSERT INTO items ("mediaId", "editionId", monitored)
  SELECT m.id, e.id, true FROM media m JOIN editions e ON e."mediaId" = m.id
  WHERE m.type = 'movie' AND NOT EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id) ORDER BY m.id;
INSERT INTO persons (id, "createdAt", "updatedAt", "tmdbId", name, biography, "knownForDepartment", departments, "metadataRefreshedAt", provider) VALUES
 (201, '2026-01-01', '2026-01-01', 102, 'Claude Old Name', 'Old bio', 'Acting', '["Writing"]', now() - interval '30 days', 'tmdb');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
