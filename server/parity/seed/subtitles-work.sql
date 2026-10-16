-- Parity seed delta "subtitles-work" (docs/spec/subtitles.md, subtitle-files.md), on top of base.sql.
-- Writes only under /tmp/fliks-parity/s6/subtitles-work (scenario `fsDir` rebuilds it): never the base media tree.
INSERT INTO language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") VALUES
 (2, '2026-01-01', '2026-01-01', 'Subs', '[]',
  '[{"isoCode":"en","name":"English","forced":false,"hi":false},{"isoCode":"fr","name":"French","forced":false,"hi":false,"hearingImpaired":"require"}]');
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path) VALUES
 (3, '2026-01-01', '2026-01-01', 'Work Movies', 'film', '#111111', '["movie"]', '/tmp/fliks-parity/s6/subtitles-work/movies'),
 (4, '2026-01-01', '2026-01-01', 'Work Series', 'tv', '#222222', '["series"]', '/tmp/fliks-parity/s6/subtitles-work/series');
INSERT INTO media (id, "createdAt", "updatedAt", title, year, type, "tmdbId", "imdbId", overview, status, monitored, "folderName", genres, "libraryId", "languageProfileId") VALUES
 (101, '2026-01-01', '2026-01-01', 'Work Movie', 2020, 'movie', 5101, 'tt9000101', 'Work movie', 'released', true, 'Work Movie (2020)', '[]', 3, 2),
 (103, '2026-01-01', '2026-01-01', 'Work Show', 2021, 'series', 5103, 'tt9000103', 'Work show', 'continuing', true, 'Work Show', '[]', 4, 2);
INSERT INTO seasons (id, "createdAt", "updatedAt", "seasonNumber", monitored, "mediaId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, true, 103);
INSERT INTO episodes (id, "createdAt", "updatedAt", "episodeNumber", title, monitored, "hasFile", "seasonId") VALUES
 (101, '2026-01-01', '2026-01-01', 1, 'Pilot', true, true, 101);
INSERT INTO media_files (id, "createdAt", "updatedAt", "mediaId", "episodeId", "relativePath", size, quality, language) VALUES
 (101, '2026-01-01', '2026-01-01', 101, NULL, 'Work.Movie.2020.1080p.BluRay.x264-GRP.mkv', 73237, 'Bluray-1080p', 'en'),
 (102, '2026-01-01', '2026-01-01', 103, 101, 'Season 01/Work.Show.S01E01.1080p.WEB-DL.x264-GRP.mkv', 73237, 'WEBDL-1080p', 'en');
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
