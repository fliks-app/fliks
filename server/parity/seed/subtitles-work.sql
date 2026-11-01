-- Parity seed delta "subtitles-work" (docs/spec/subtitles.md, subtitle-files.md), on top of base.sql.
-- Writes only under /tmp/fliks-parity/s6/subtitles-work (scenario `fsDir` rebuilds it): never the base media tree.
INSERT INTO language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") VALUES
 (2, '2026-01-01', '2026-01-01', 'Subs', '[]',
  '[{"isoCode":"en","name":"English","forced":false,"hi":false},{"isoCode":"fr","name":"French","forced":false,"hi":false,"hearingImpaired":"require"}]');
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path) VALUES
 (3, '2026-01-01', '2026-01-01', 'Work Movies', 'film', '#111111', '["movie"]', '/tmp/fliks-parity/s6/subtitles-work/movies'),
 (4, '2026-01-01', '2026-01-01', 'Work Series', 'tv', '#222222', '["series"]', '/tmp/fliks-parity/s6/subtitles-work/series');
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, overview, status, monitored, "folderName", genres, "libraryId", "languageProfileId") VALUES
 (101, '2026-01-01', '2026-01-01', 'Work Movie', 2020, 'movie', 'Work movie', 'released', true, 'Work Movie (2020)', '[]', 3, 2),
 (103, '2026-01-01', '2026-01-01', 'Work Show', 2021, 'series', 'Work show', 'continuing', true, 'Work Show', '[]', 4, 2);
INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES
 (101, 'movie', 'tmdb', '5101'),
 (101, 'movie', 'imdb', 'tt9000101'),
 (103, 'series', 'tmdb', '5103'),
 (103, 'series', 'imdb', 'tt9000103');
INSERT INTO editions ("mediaId", family)
  SELECT id, 'video' FROM media m WHERE NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id) ORDER BY id;
INSERT INTO item_groups (id, "createdAt", "updatedAt", "number", monitored, "mediaId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, true, 103);
INSERT INTO items (id, "createdAt", "updatedAt", "number", title, monitored, "groupId", "mediaId", "editionId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, 'Pilot', true, 101, 103, (SELECT id FROM editions WHERE "mediaId" = 103));
INSERT INTO items ("mediaId", "editionId", monitored)
  SELECT m.id, e.id, true FROM media m JOIN editions e ON e."mediaId" = m.id
  WHERE m.type = 'movie' AND NOT EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id) ORDER BY m.id;
INSERT INTO media_files (id, "createdAt", "updatedAt", "mediaId", "relativePath", size, quality, language) VALUES
 (101, '2026-01-01', '2026-01-01', 101, 'Work.Movie.2020.1080p.BluRay.x264-GRP.mkv', 73237, 'Bluray-1080p', 'en'),
 (102, '2026-01-01', '2026-01-01', 103, 'Season 01/Work.Show.S01E01.1080p.WEB-DL.x264-GRP.mkv', 73237, 'WEBDL-1080p', 'en');
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId")
  SELECT COALESCE(v.item, i.id), f.id, f."mediaId" FROM media_files f
  JOIN (VALUES (101, NULL::int), (102, 101)) AS v(file, item) ON v.file = f.id
  LEFT JOIN items i ON i."mediaId" = f."mediaId" AND i."groupId" IS NULL;
INSERT INTO subtitle_providers (id, "createdAt", "updatedAt", name, type, enabled, settings, priority) VALUES
 (1, '2026-01-01', '2026-01-01', 'Subdl', 'subdl', true, '{"apiKey":"sk"}', 1);
INSERT INTO subtitle_provider_stats (id, "queryDate", "queryType", "responseTimeMs", "resultCount", "errorMessage", "providerId") VALUES
 (1, now() - interval '1 day', 'search', 120, 4, NULL, 1),
 (2, now() - interval '29 days', 'search', 380, 0, 'boom', 1),
 (3, now() - interval '31 days', 'download', 900, 1, NULL, 1);
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
