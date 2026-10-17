-- Parity seed delta "livetv-live" (docs/spec/livetv-sessions.md): the lineup of the milestone gate on top of base.sql.
-- A and B share S1 (one connection), C has a dead first url, D only dead ones, R is restricted, F's account expired,
-- G's source is disabled, H needs the stream's own user agent.
ALTER TABLE livetv_channels DISABLE TRIGGER set_updated_at;
INSERT INTO roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") VALUES (5, '2026-01-01', '2026-01-01', 'NoRead', '[]', false);
INSERT INTO users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "isAdmin") VALUES
 (6, '2026-01-01', '2026-01-01', 'noread', 'noread@parity.test', '$2b$10$Y.5IbQnOtCy7KYdDjolww.zQB.e0Jl22TcQkZM6nq8TjMRAROCJGi', 5, false);
INSERT INTO livetv_sources (id, "createdAt", "updatedAt", name, kind, url, "maxStreams", "maxStreamsIsManual", "accountStatus", "expiresAt", enabled, priority, "lastSyncStatus") VALUES
 (1, '2026-01-01', '2026-01-01', 'S1', 'm3u', 'http://127.0.0.1:4961/test.m3u', 1, true, NULL, NULL, true, 0, 'ok'),
 (2, '2026-01-01', '2026-01-01', 'S2', 'm3u', 'http://127.0.0.1:4961/test.m3u', 0, false, NULL, NULL, true, 1, 'ok'),
 (3, '2026-01-01', '2026-01-01', 'Expired', 'm3u', 'http://127.0.0.1:4961/test.m3u', 0, false, 'Expired', '2026-01-01', true, 2, 'ok'),
 (4, '2026-01-01', '2026-01-01', 'Off', 'm3u', 'http://127.0.0.1:4961/test.m3u', 0, false, NULL, NULL, false, 3, 'ok');
INSERT INTO livetv_channels (id, "createdAt", "updatedAt", name, number, "groupName", enabled) VALUES
 (1, '2026-01-01', '2026-01-01', 'A', 1, 'Live', true), (2, '2026-01-01', '2026-01-01', 'B', 2, 'Live', true),
 (3, '2026-01-01', '2026-01-01', 'C', 3, 'Live', true), (4, '2026-01-01', '2026-01-01', 'D', 4, 'Live', true),
 (5, '2026-01-01', '2026-01-01', 'E', 5, 'Live', true), (6, '2026-01-01', '2026-01-01', 'R', 6, 'Adult XXX', true),
 (7, '2026-01-01', '2026-01-01', 'F', 7, 'Live', true), (8, '2026-01-01', '2026-01-01', 'G', 8, 'Live', true),
 (9, '2026-01-01', '2026-01-01', 'H', 9, 'Live', true);
INSERT INTO livetv_channel_streams (id, "createdAt", "updatedAt", "externalId", url, priority, "providerName", "userAgent", "channelId", "sourceId") VALUES
 (1, '2026-01-01', '2026-01-01', 'a', 'http://127.0.0.1:4961/stream/a.ts', 0, 'A', NULL, 1, 1),
 (2, '2026-01-01', '2026-01-01', 'b', 'http://127.0.0.1:4961/stream/b.ts', 0, 'B', NULL, 2, 1),
 (3, '2026-01-01', '2026-01-01', 'c1', 'http://127.0.0.1:4961/stream/dead/c1.ts', 0, 'C', NULL, 3, 2),
 (4, '2026-01-01', '2026-01-01', 'c2', 'http://127.0.0.1:4961/stream/c2.ts', 1, 'C', NULL, 3, 2),
 (5, '2026-01-01', '2026-01-01', 'd1', 'http://127.0.0.1:4961/stream/dead/d1.ts', 0, 'D', NULL, 4, 2),
 (6, '2026-01-01', '2026-01-01', 'd2', 'http://127.0.0.1:4961/stream/dead/d2.ts', 1, 'D', NULL, 4, 2),
 (7, '2026-01-01', '2026-01-01', 'e', 'http://127.0.0.1:4961/stream/e.ts', 0, 'E', NULL, 5, 2),
 (8, '2026-01-01', '2026-01-01', 'r', 'http://127.0.0.1:4961/stream/r.ts', 0, 'R', NULL, 6, 2),
 (9, '2026-01-01', '2026-01-01', 'f', 'http://127.0.0.1:4961/stream/dead/f.ts', 0, 'F', NULL, 7, 3),
 (10, '2026-01-01', '2026-01-01', 'g', 'http://127.0.0.1:4961/stream/g.ts', 0, 'G', NULL, 8, 4),
 (11, '2026-01-01', '2026-01-01', 'h', 'http://127.0.0.1:4961/ua-only.ts', 0, 'H', 'EntryAgent/1.0', 9, 2);
INSERT INTO livetv_group_access (id, "createdAt", "updatedAt", "groupName", "userId") VALUES (1, '2026-01-01', '2026-01-01', 'Adult XXX', 4);
INSERT INTO app_settings (key, value) VALUES ('livetv_restricted_groups', '["Adult XXX"]');
ALTER TABLE livetv_channels ENABLE TRIGGER set_updated_at;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
