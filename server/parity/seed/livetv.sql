-- Parity seed delta "livetv" (docs/spec/livetv-*.md), on top of base.sql: two sources, six channels in three
-- groups (one restricted), grants, prefs, two guide sources and a guide around the time of the run.
ALTER TABLE livetv_channels DISABLE TRIGGER set_updated_at;
ALTER TABLE livetv_sources DISABLE TRIGGER set_updated_at;
ALTER TABLE livetv_guide_sources DISABLE TRIGGER set_updated_at;
INSERT INTO roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") VALUES (5, '2026-01-01', '2026-01-01', 'NoRead', '[]', false);
INSERT INTO users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "isAdmin") VALUES
 (6, '2026-01-01', '2026-01-01', 'noread', 'noread@parity.test', '$2b$10$Y.5IbQnOtCy7KYdDjolww.zQB.e0Jl22TcQkZM6nq8TjMRAROCJGi', 5, false);

INSERT INTO livetv_sources (id, "createdAt", "updatedAt", name, kind, url, username, password, "userAgent", referer, "maxStreams", "maxStreamsIsManual",
  "refreshIntervalHours", "includeGroupsPattern", "excludeGroupsPattern", "guideUrls", enabled, priority, "lastSyncAt", "lastSyncStatus", "channelCount") VALUES
 (1, '2026-01-01', '2026-01-01', 'Alpha', 'm3u', 'http://127.0.0.1:4921/playlist.m3u', NULL, NULL, NULL, NULL, 2, false, 12, NULL, NULL,
  '["http://127.0.0.1:4921/guide.xml"]', true, 0, '2026-01-02 10:00', 'ok', 5),
 (2, '2026-01-01', '2026-01-01', 'Beta', 'xtream', 'http://127.0.0.1:4921', 'u', 'p', 'BetaAgent/1', 'http://beta.example/', 1, true, 6, NULL, NULL,
  '[]', true, 1, NULL, 'never', 0);
INSERT INTO livetv_channels (id, "createdAt", "updatedAt", name, number, "logoPath", "groupName", "groupNameSource", enabled, "sortIndex", "guideChannelId", "guideMatchKind", "guideShiftMinutes") VALUES
 (1, '2026-01-01', '2026-01-01', 'One', 1, 'http://127.0.0.1:4921/logo/1.png', 'Old News', 'provider', true, 0, 'one.fr', 'id', 0),
 (2, '2026-01-01', '2026-01-01', 'Two', 2, NULL, 'Mine', 'manual', true, 0, 'two.fr', 'name', 0),
 (3, '2026-01-01', '2026-01-01', 'Adult XXX 1', 3, NULL, 'Adult XXX', 'manual', true, 0, 'adult.fr', 'manual', 0),
 (4, '2026-01-01', '2026-01-01', 'No Group', NULL, NULL, '__livetv_ungrouped__', 'provider', true, 5, NULL, NULL, 0),
 (5, '2026-01-01', '2026-01-01', 'Hidden One', 5, NULL, 'News', 'provider', true, 0, 'hidden.fr', 'fuzzy', 30),
 (6, '2026-01-01', '2026-01-01', 'Disabled', 6, NULL, 'Sport', 'provider', false, 0, NULL, NULL, 0);
INSERT INTO livetv_channel_streams (id, "createdAt", "updatedAt", "externalId", url, priority, "qualityLabel", "providerName", "userAgent", referer, "lastSeenAt", "channelId", "sourceId") VALUES
 (1, '2026-01-01', '2026-01-01', '101', 'http://127.0.0.1:4921/live/u/p/101.ts', 0, 'HD', 'One HD', NULL, NULL, '2026-01-02 10:00', 1, 1),
 (2, '2026-01-01', '2026-01-01', '102', 'http://127.0.0.1:4921/live/u/p/102.ts', 1, NULL, 'One FHD', NULL, NULL, '2026-01-02 10:00', 1, 1),
 (3, '2026-01-01', '2026-01-01', '103', 'http://127.0.0.1:4921/live/u/p/103.ts', 0, NULL, 'Two', NULL, NULL, '2026-01-02 10:00', 2, 1),
 (4, '2026-01-01', '2026-01-01', '301', 'http://127.0.0.1:4921/live/u/p/301.ts', 0, NULL, 'Adult XXX 1', NULL, NULL, '2026-01-02 10:00', 3, 1),
 (5, '2026-01-01', '2026-01-01', '105', 'http://127.0.0.1:4921/live/u/p/105.ts', 0, NULL, 'No Group', NULL, NULL, '2026-01-02 10:00', 4, 1),
 (6, '2026-01-01', '2026-01-01', '501', 'http://127.0.0.1:4921/live/u/p/501.ts', 0, NULL, 'Hidden One', NULL, NULL, '2026-01-02 10:00', 5, 1),
 (7, '2026-01-01', '2026-01-01', '601', 'http://127.0.0.1:4921/live/u/p/601.ts', 0, NULL, 'Disabled', NULL, NULL, '2026-01-02 10:00', 6, 1);
INSERT INTO livetv_user_channel_prefs (id, "createdAt", "updatedAt", favorite, hidden, "userId", "channelId") VALUES
 (1, '2026-01-01', '2026-01-01', true, false, 2, 2),
 (2, '2026-01-01', '2026-01-01', false, true, 2, 5);
INSERT INTO livetv_group_access (id, "createdAt", "updatedAt", "groupName", "userId") VALUES (1, '2026-01-01', '2026-01-01', 'Adult XXX', 4);
INSERT INTO app_settings (key, value) VALUES
 ('livetv_restricted_groups', '["Adult XXX"]'),
 ('livetv_restricted_groups_exempt', '[]'),
 ('livetv_restricted_groups_vanished', '{}');

INSERT INTO livetv_guide_sources (id, "createdAt", "updatedAt", name, kind, url, "sourceId", "refreshIntervalHours", "timezoneOffsetMinutes", language, priority, enabled, "lastSyncStatus") VALUES
 (1, '2026-01-01', '2026-01-01', 'Feed A', 'xmltv', 'http://127.0.0.1:4921/guide.xml', NULL, 12, 0, NULL, 1, true, 'never'),
 (2, '2026-01-01', '2026-01-01', 'Feed B', 'source', NULL, 1, 12, 60, 'fr', 0, true, 'never');
INSERT INTO livetv_guide_channels (id, "createdAt", "updatedAt", "channelId", "displayNames", "iconUrl", "guideSourceId") VALUES
 (1, '2026-01-01', '2026-01-01', 'one.fr', '["One","One HD"]', NULL, 1),
 (2, '2026-01-01', '2026-01-01', 'two.fr', '["Two"]', 'http://127.0.0.1:4921/logo/2.png', 1),
 (3, '2026-01-01', '2026-01-01', 'adult.fr', '[]', NULL, 1),
 (4, '2026-01-01', '2026-01-01', 'one.fr', '["One"]', NULL, 2);
INSERT INTO livetv_programs (id, "createdAt", "updatedAt", "guideChannelId", "startsAt", "endsAt", title, subtitle, description, categories, "iconUrl",
  "seasonNumber", "episodeNumber", "seriesId", "isNew", "isLive", rating, year, "guideSourceId")
SELECT row_number() OVER (), '2026-01-01', '2026-01-01', g.cid, now() + g.a * interval '1 minute', now() + g.b * interval '1 minute', g.title, NULL,
       'About ' || g.title, '["Cat"]', NULL, NULL, NULL, NULL, false, false, NULL, NULL, g.src
FROM (VALUES
  ('one.fr', -90, -30, 'One Before', 1), ('one.fr', -30, 90, 'One Now', 1), ('one.fr', 90, 210, 'One Later', 1),
  ('one.fr', -45, 75, 'One Now (feed B)', 2),
  ('two.fr', -60, 60, 'Two Now', 1), ('two.fr', 60, 180, 'Two Later', 1),
  ('adult.fr', -60, 60, 'Adult Now', 1),
  ('hidden.fr', -60, 60, 'Hidden Now', 1)
) AS g(cid, a, b, title, src);
UPDATE livetv_programs SET "isNew" = true, rating = 'PG', year = 2020, "seasonNumber" = 1, "episodeNumber" = 2 WHERE title = 'One Now';

ALTER TABLE livetv_channels ENABLE TRIGGER set_updated_at;
ALTER TABLE livetv_sources ENABLE TRIGGER set_updated_at;
ALTER TABLE livetv_guide_sources ENABLE TRIGGER set_updated_at;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
