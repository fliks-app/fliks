-- Parity seed delta "subtitles" (docs/spec/subtitles.md, subtitle-providers.md, translation.md), on top of base.sql.
-- DB only: no scenario writes a sidecar, so the base media tree is never touched.
INSERT INTO language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") VALUES
 (2, '2026-01-01', '2026-01-01', 'Subs', '[]',
  '[{"isoCode":"en","name":"English","forced":false,"hi":false},{"isoCode":"fr","name":"French","forced":false,"hi":true},{"isoCode":"de","name":"German","forced":true,"hi":false}]');
UPDATE media SET "languageProfileId" = 2 WHERE id IN (1, 2);
INSERT INTO subtitle_files (id, "createdAt", "updatedAt", "mediaId", "mediaFileId", language, forced, "hearingImpaired", "providerType", "providerFileId", "filePath", status, "streamIndex", "sourceStreamIndex", codec, score, "hashMatched", synced, locked) VALUES
 (1, '2026-02-01 10:00', '2026-02-01 10:00', 1, 1, 'en', false, false, 'embedded', NULL, NULL, 'embedded', 1, NULL, 'subrip', 100, false, false, false),
 (2, '2026-02-02 10:00', '2026-02-02 10:00', 1, 1, 'und', false, false, 'embedded', NULL, NULL, 'embedded', 2, NULL, 'hdmv_pgs_subtitle', 100, false, false, false),
 (3, '2026-02-03 10:00', '2026-02-03 10:00', 1, 1, 'fr', false, false, 'disk', NULL, 'Parity Movie 01 (2020)/Parity Movie 01 (2020).fr.srt', 'downloaded', NULL, NULL, NULL, 100, false, true, false),
 (4, '2026-02-04 10:00', '2026-02-04 10:00', 1, 1, 'en', false, true, 'opensubtitles', '99', 'Parity Movie 01 (2020)/Parity Movie 01 (2020).en.hi.srt', 'downloaded', NULL, NULL, 'subrip', 55, false, false, false),
 (5, '2026-02-05 10:00', '2026-02-05 10:00', 1, 1, 'fr', false, false, 'ocr', NULL, NULL, 'failed', NULL, 2, 'subrip', 100, false, false, false),
 (6, '2026-02-06 10:00', '2026-02-06 10:00', 2, 2, 'de', true, false, 'disk', NULL, 'Parity Movie 02 (2020)/Parity Movie 02 (2020).de.forced.srt', 'downloaded', NULL, NULL, NULL, 100, false, true, false),
 (7, '2026-02-07 10:00', '2026-02-07 10:00', 1, 1, 'en', false, false, 'embedded', NULL, NULL, 'embedded', 3, NULL, 'dvb_subtitle', 100, false, false, false),
 (8, '2026-02-08 10:00', '2026-02-08 10:00', 1, 1, 'en', false, false, 'disk', NULL, 'Parity Movie 01 (2020)/Parity Movie 01 (2020).pgs.sup', 'downloaded', NULL, NULL, 'hdmv_pgs_subtitle', 100, false, true, false);
UPDATE subtitle_files SET "errorMessage" = 'activity.subtitle_error_interrupted' WHERE id = 5;
INSERT INTO subtitle_providers (id, "createdAt", "updatedAt", name, type, enabled, settings, priority) VALUES
 (1, '2026-01-01', '2026-01-01', 'OpenSubtitles', 'opensubtitles', false, '{"username":"u","password":"secret","apiKey":"key"}', 1),
 (2, '2026-01-01', '2026-01-01', 'Subdl', 'subdl', false, '{"apiKey":"sk"}', 5),
 (3, '2026-01-01', '2026-01-01', 'YIFY', 'yify', false, '{}', 25);
INSERT INTO subtitle_provider_stats (id, "queryDate", "queryType", "responseTimeMs", "resultCount", "errorMessage", "providerId") VALUES
 (1, now() - interval '1 day', 'search', 120, 4, NULL, 1),
 (2, now() - interval '1 day', 'search', 380, 0, 'boom', 1),
 (3, now() - interval '3 days', 'download', 900, 1, NULL, 1),
 (4, now() - interval '90 days', 'search', 50, 9, NULL, 1);
INSERT INTO subtitle_blacklist (id, "createdAt", "updatedAt", "providerType", "providerFileId", "mediaId", language, "sourceTitle", reason) VALUES
 (1, '2026-03-01 10:00', '2026-03-01 10:00', 'opensubtitles', '123', 1, 'en', 'Bad.Release', 'out of sync'),
 (2, '2026-03-02 10:00', '2026-03-02 10:00', 'subdl', '/subtitle/9.zip', NULL, NULL, NULL, NULL);
INSERT INTO translation_providers (id, "createdAt", "updatedAt", name, engine, enabled, "isDefault", settings) VALUES
 (1, '2026-01-01', '2026-01-01', 'Gemini', 'gemini', true, true, '{"apiKey":"gk","model":"gemini-3.5-flash-lite"}'),
 (2, '2026-01-01', '2026-01-01', 'Local', 'openai', true, false, '{"baseUrl":"http://127.0.0.1:1/v1","model":"m","apiKey":"ok"}'),
 (3, '2026-01-01', '2026-01-01', 'Libre', 'libretranslate', false, false, '{"url":"http://127.0.0.1:1"}');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
