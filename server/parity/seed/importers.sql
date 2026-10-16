-- Parity seed delta "importers" (docs/spec/importers.md Vectors/parity), applied on top of base.sql by the runner.
INSERT INTO quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items) VALUES
 (1, '2026-01-01', '2026-01-01', 'Existing HD', 18, '[]');
INSERT INTO app_settings (key, value) VALUES
 ('radarr_url', 'http://127.0.0.1:4880/radarr/ok'), ('radarr_api_key', 'parity-key'),
 ('sonarr_url', 'http://127.0.0.1:4880/sonarr/ok'), ('sonarr_api_key', 'parity-key'),
 ('seerr_url', 'http://127.0.0.1:4880/seerr/ok'), ('seerr_api_key', 'parity-key');
UPDATE app_settings SET "createdAt" = '2026-01-01', "updatedAt" = '2026-01-01' WHERE key LIKE 'radarr_%' OR key LIKE 'sonarr_%' OR key LIKE 'seerr_%';
SELECT setval(pg_get_serial_sequence('quality_profiles', 'id'), 1, true);
SELECT setval(pg_get_serial_sequence('app_settings', 'id'), (SELECT max(id) FROM app_settings), true);
