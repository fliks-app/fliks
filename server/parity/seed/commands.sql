-- Parity seed delta "commands" (docs/spec/scheduler.md Vectors/parity), applied on top of base.sql by the runner.
-- One row of each status, one old enough to prune, two sharing a createdAt (the id DESC tie-break).
ALTER TABLE commands DISABLE TRIGGER set_updated_at;
INSERT INTO commands (id, "createdAt", "updatedAt", name, status, "startedOn", "endedOn", trigger, body) VALUES
 (1, '2025-01-01 10:00:00+00', '2025-01-01 10:00:00+00', 'Backup', 'completed', '2025-01-01 10:00:00+00', '2025-01-01 10:00:05+00', 'scheduled', NULL),
 (2, '2026-10-01 10:00:00+00', '2026-10-01 10:00:00+00', 'RefreshMetadata', 'failed', '2026-10-01 10:00:00+00', '2026-10-01 10:00:09+00', 'manual', NULL),
 (3, '2026-10-02 10:00:00+00', '2026-10-02 10:00:00+00', 'RescanAll', 'running', '2026-10-02 10:00:00+00', NULL, 'manual', NULL),
 (4, '2026-10-03 10:00:00+00', '2026-10-03 10:00:00+00', 'DetectMarkers', 'queued', NULL, NULL, 'manual', NULL),
 (5, '2026-10-04 12:00:00+00', '2026-10-04 12:00:00+00', 'Backup', 'completed', '2026-10-04 12:00:00+00', '2026-10-04 12:00:03+00', 'scheduled', NULL),
 (6, '2026-10-04 12:00:00+00', '2026-10-04 12:00:00+00', 'RefreshMetadata', 'completed', '2026-10-04 12:00:00+00', '2026-10-04 12:00:04+00', 'scheduled', NULL),
 (7, '2026-10-05 08:00:00+00', '2026-10-05 08:00:00+00', 'IntroDetection', 'completed', '2026-10-05 08:00:00+00', '2026-10-05 08:00:02+00', 'auto', '{"seasonId": 1, "mediaId": 1, "seasonNumber": 1}');
SELECT setval(pg_get_serial_sequence('commands', 'id'), 7);
ALTER TABLE commands ENABLE TRIGGER set_updated_at;
