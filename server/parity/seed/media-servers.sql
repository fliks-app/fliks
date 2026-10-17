-- Parity seed delta "media-servers" (docs/spec/media-servers.md Vectors/parity), applied on top of base.sql.
-- Servers point at server/parity/stubs/emby-stub.mjs on 127.0.0.1:4962; the first path segment is the stub mode.
INSERT INTO media_servers (id, "createdAt", "updatedAt", name, type, url, "apiKey", events, enabled) VALUES
 (1, '2026-01-01', '2026-01-01', 'Emby Main', 'emby', 'http://127.0.0.1:4962/ok', 'parity-key', '["library.rescan","media.deleted"]', true),
 (2, '2026-01-01', '2026-01-01', 'Emby Spare', 'emby', 'http://127.0.0.1:4962/ok/', 'parity-key', '[]', false),
 (3, '2026-01-01', '2026-01-01', 'Plex Box', 'plex', 'http://127.0.0.1:4962/ok', 'plex-key', '[]', true),
 (4, '2026-01-01', '2026-01-01', 'Emby Bad Key', 'emby', 'http://127.0.0.1:4962/401', 'wrong', '[]', true),
 (5, '2026-01-01', '2026-01-01', 'Emby No Users', 'emby', 'http://127.0.0.1:4962/nousers', 'parity-key', '[]', true),
 (6, '2026-01-01', '2026-01-01', 'Emby Slow', 'emby', 'http://127.0.0.1:4962/slow', 'parity-key', '[]', true);
SELECT setval(pg_get_serial_sequence('media_servers', 'id'), 6);
