-- Parity seed delta "media-query" (docs/spec/media-query.md Vectors/parity), applied on top of base.sql by the runner.
-- Deterministic: every inserted row has explicit ids and timestamps; media dates are days apart, files hours apart.
ALTER TABLE media DISABLE TRIGGER set_updated_at;
ALTER TABLE media_files DISABLE TRIGGER set_updated_at;

-- noread actor: authenticates but holds no permission (403 on every media route)
INSERT INTO roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") VALUES (5, '2026-01-01', '2026-01-01', 'NoRead', '[]', false);
INSERT INTO users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "isAdmin") VALUES
 (6, '2026-01-01', '2026-01-01', 'noread', 'noread@parity.test', '$2b$10$Y.5IbQnOtCy7KYdDjolww.zQB.e0Jl22TcQkZM6nq8TjMRAROCJGi', 5, false);

INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path) VALUES (3, '2026-01-01', '2026-01-01', 'Pathless', 'film', '#ef4444', '["movie"]', NULL);
INSERT INTO quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items) VALUES
 (1, '2026-01-01', '2026-01-01', 'Parity HD', 18, '[]'), (2, '2026-01-01', '2026-01-01', 'Parity Unknown Cutoff', 99, '[]');
ALTER TABLE libraries DISABLE TRIGGER set_updated_at;
UPDATE libraries SET "defaultQualityProfileId" = 1, "defaultLanguageProfileId" = 1 WHERE id = 1;
ALTER TABLE libraries ENABLE TRIGGER set_updated_at;

UPDATE media m SET year = v.year, rating = v.rating, genres = v.genres FROM (VALUES
 (1, 2020, 7.5, '["Drama"]'::jsonb),
 (2, 2019, 8.0, '["Action", "Drama"]'::jsonb),
 (3, 2021, 7.5, '["Action", "Thriller"]'::jsonb),
 (4, 2018, 6.0, '["Comedy"]'::jsonb),
 (5, NULL::int, NULL::float8, NULL::jsonb),
 (6, 2017, 9.0, '["Drama"]'::jsonb),
 (7, 2020, 7.5, '["Sci-Fi", "Action"]'::jsonb),
 (8, 2016, 6.0, '["Comedy", "Drama"]'::jsonb),
 (9, 2015, NULL::float8, '[]'::jsonb),
 (10, 2019, 8.0, '["Drama"]'::jsonb),
 (11, 2021, 7.5, '["Thriller"]'::jsonb),
 (12, 2014, 5.0, '["Horror"]'::jsonb),
 (13, NULL::int, 7.5, '["Action"]'::jsonb),
 (14, 2018, 6.0, '["Sci-Fi"]'::jsonb),
 (15, 2022, 9.0, '["Drama", "Crime"]'::jsonb),
 (16, 2013, NULL::float8, '["Comedy"]'::jsonb),
 (17, 2020, 7.5, '["Action", "Drama"]'::jsonb),
 (18, 2021, 8.0, '["Drama"]'::jsonb),
 (19, 2020, NULL::float8, '["Comedy"]'::jsonb),
 (20, 2022, 7.0, '["Sci-Fi", "Drama"]'::jsonb)
) AS v(id, year, rating, genres) WHERE m.id = v.id;
UPDATE media SET "posterUrl" = '/api/images/' || id || '/poster' WHERE id <= 8;
UPDATE media SET "fanartUrl" = '/api/images/' || id || '/fanart' WHERE id IN (2, 4);
-- updated before any insert so the heap order stays the id order
UPDATE media_files SET "createdAt" = '2026-02-01'::timestamptz + (id * 37 % 101) * interval '1 hour' WHERE id <= 29;

INSERT INTO media (id, "createdAt", "updatedAt", title, "originalTitle", year, type, overview, status, monitored, "folderName", rating, genres, runtime, "libraryId", "languageProfileId", "addedById", "posterUrl", "fanartUrl") VALUES
 (21, '2026-01-01'::timestamptz + interval '21 days', '2026-01-01', 'alpha test', 'Alpha Original', 2015, 'movie', 'A comedy about impossible things', 'released', true, 'alpha test (2020)', 6.0, '["Comedy"]'::jsonb, NULL, 1, NULL, 2, NULL, NULL),
 (22, '2026-01-01'::timestamptz + interval '22 days', '2026-01-01', '12 Angry Men', NULL, 1957, 'movie', 'Twelve jurors decide a verdict', 'released', true, '12 Angry Men (2020)', 9.0, '["Drama"]'::jsonb, NULL, 1, NULL, 2, NULL, NULL),
 (23, '2026-01-01'::timestamptz + interval '23 days', '2026-01-01', 'Éclair', NULL, NULL, 'movie', NULL, 'released', true, 'Éclair (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (24, '2026-01-01'::timestamptz + interval '24 days', '2026-01-01', 'L''Impossible', 'Lo Imposible', 2012, 'movie', 'Une famille survit au tsunami', 'released', true, 'L''Impossible (2020)', 7.6, '["Drama", "Thriller"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (25, '2026-01-01'::timestamptz + interval '25 days', '2026-01-01', 'Les Évadés', 'The Shawshank Redemption', 1994, 'movie', 'Un banquier condamné s''évade de prison', 'released', true, 'Les Évadés (2020)', 8.7, '["Drama", "Crime"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (26, '2026-01-01'::timestamptz + interval '26 days', '2026-01-01', 'Zeta Alpha Alpha', NULL, 2018, 'movie', NULL, 'released', true, 'Zeta Alpha Alpha (2020)', 5.5, '["drama"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (27, '2026-01-01'::timestamptz + interval '27 days', '2026-01-01', 'Unidentified Movie', NULL, 2019, 'movie', NULL, 'released', true, 'Unidentified Movie (2020)', 6.5, '["Comedy", "Drama"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (28, '2026-01-01'::timestamptz + interval '28 days', '2026-01-01', 'Empty Imdb Movie', NULL, 2019, 'movie', NULL, 'released', true, 'Empty Imdb Movie (2020)', 6.5, '["Comedy"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (29, '2026-01-01'::timestamptz + interval '29 days', '2026-01-01', 'Unmonitored Movie', NULL, 2023, 'movie', NULL, 'announced', false, 'Unmonitored Movie (2020)', 4.0, '["Horror"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (30, '2026-01-01'::timestamptz + interval '30 days', '2026-01-01', 'No Files Movie', NULL, 2025, 'movie', NULL, 'tba', true, 'No Files Movie (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (31, '2026-01-01'::timestamptz + interval '31 days', '2026-01-01', 'Null Library Movie', NULL, 2020, 'movie', NULL, 'released', true, 'Null Library Movie (2020)', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 (32, '2026-01-01'::timestamptz + interval '32 days', '2026-01-01', 'Collection Alpha 1', NULL, 2010, 'movie', NULL, 'released', true, 'Collection Alpha 1 (2020)', 7.0, '["Drama"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (33, '2026-01-01'::timestamptz + interval '33 days', '2026-01-01', 'Collection Alpha 2', NULL, 2012, 'movie', NULL, 'released', true, 'Collection Alpha 2 (2020)', 7.2, '["Drama", "Action"]'::jsonb, NULL, 1, NULL, NULL, NULL, NULL),
 (34, '2026-01-01'::timestamptz + interval '34 days', '2026-01-01', 'Collection Solo', NULL, 2014, 'movie', NULL, 'released', true, 'Collection Solo (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (35, '2026-01-01'::timestamptz + interval '35 days', '2026-01-01', 'Collection Other Library', NULL, 2011, 'movie', NULL, 'released', true, 'Collection Other Library (2020)', NULL, NULL, NULL, 2, NULL, NULL, NULL, NULL),
 (36, '2026-01-01'::timestamptz + interval '36 days', '2026-01-01', 'Profile Movie Unmet', NULL, 2020, 'movie', NULL, 'released', true, 'Profile Movie Unmet (2020)', NULL, NULL, NULL, 1, NULL, 2, NULL, NULL),
 (37, '2026-01-01'::timestamptz + interval '37 days', '2026-01-01', 'Profile Movie Met', NULL, 2020, 'movie', NULL, 'released', true, 'Profile Movie Met (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (38, '2026-01-01'::timestamptz + interval '38 days', '2026-01-01', 'Profile Movie Empty Quality', NULL, 2020, 'movie', NULL, 'released', true, 'Profile Movie Empty Quality (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (39, '2026-01-01'::timestamptz + interval '39 days', '2026-01-01', 'Profile Movie 8K', NULL, 2020, 'movie', NULL, 'released', true, 'Profile Movie 8K (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (40, '2026-01-01'::timestamptz + interval '40 days', '2026-01-01', 'Unknown Cutoff Movie', NULL, 2020, 'movie', NULL, 'released', true, 'Unknown Cutoff Movie (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (41, '2026-01-01'::timestamptz + interval '41 days', '2026-01-01', 'Language Profile Movie', NULL, 2020, 'movie', NULL, 'released', true, 'Language Profile Movie (2020)', NULL, NULL, NULL, 1, 1, NULL, NULL, NULL),
 (42, '2026-01-01'::timestamptz + interval '42 days', '2026-01-01', 'Pathless Library Movie', NULL, 2020, 'movie', NULL, 'released', true, 'Pathless Library Movie (2020)', NULL, NULL, NULL, 3, NULL, NULL, NULL, NULL),
 (43, '2026-01-01'::timestamptz + interval '43 days', '2026-01-01', 'Series Multi', NULL, 2022, 'series', NULL, 'continuing', true, 'Series Multi (2020)', 7.0, '["Drama", "Crime"]'::jsonb, NULL, 2, NULL, NULL, NULL, NULL),
 (44, '2026-01-01'::timestamptz + interval '44 days', '2026-01-01', 'Series Watched', NULL, 2022, 'series', NULL, 'ended', true, 'Series Watched (2020)', NULL, NULL, NULL, 2, NULL, NULL, NULL, NULL),
 (45, '2026-01-01'::timestamptz + interval '45 days', '2026-01-01', 'Series Half Watched', NULL, 2023, 'series', NULL, 'continuing', true, 'Series Half Watched (2020)', NULL, NULL, NULL, 2, NULL, NULL, NULL, NULL),
 (46, '2026-01-01'::timestamptz + interval '46 days', '2026-01-01', 'Series No Files', NULL, 2019, 'series', NULL, 'ended', false, 'Series No Files (2020)', NULL, NULL, NULL, 2, NULL, NULL, NULL, NULL),
 (47, '2026-01-01'::timestamptz + interval '47 days', '2026-01-01', 'Series Calendar', NULL, 2026, 'series', NULL, 'continuing', true, 'Series Calendar (2020)', NULL, '["Drama"]'::jsonb, NULL, 2, NULL, 2, NULL, NULL),
 (48, '2026-01-01'::timestamptz + interval '48 days', '2026-01-01', 'Cal Movie Cinema Digital', NULL, 2026, 'movie', NULL, 'released', true, 'Cal Movie Cinema Digital (2020)', NULL, NULL, NULL, 1, NULL, 2, NULL, NULL),
 (49, '2026-01-01'::timestamptz + interval '49 days', '2026-01-01', 'Cal Movie Release Only', NULL, 2026, 'movie', NULL, 'released', true, 'Cal Movie Release Only (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (50, '2026-01-01'::timestamptz + interval '50 days', '2026-01-01', 'Cal Movie Release Inside Cinema Outside', NULL, 2026, 'movie', NULL, 'released', true, 'Cal Movie Release Inside Cinema Outside (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL),
 (51, '2026-01-01'::timestamptz + interval '51 days', '2026-01-01', 'No Signal Movie', NULL, 2020, 'movie', NULL, 'released', true, 'No Signal Movie (2020)', NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL);
INSERT INTO wants ("mediaId", family, "qualityProfileId")
  SELECT m.id, 'video', CASE m.id WHEN 40 THEN 2 WHEN 21 THEN 1 WHEN 30 THEN 1 WHEN 36 THEN 1 WHEN 37 THEN 1 WHEN 38 THEN 1 WHEN 39 THEN 1 WHEN 43 THEN 1 WHEN 44 THEN 1 END
  FROM media m WHERE NOT EXISTS (SELECT 1 FROM wants w WHERE w."mediaId" = m.id) ORDER BY m.id;
INSERT INTO collections (id, name) VALUES (1, 'Alpha Collection'), (2, 'Solo Collection');
INSERT INTO collection_external_ids ("collectionId", provider, value) VALUES (1, 'tmdb', '500'), (2, 'tmdb', '501');
INSERT INTO collection_entries ("collectionId", "mediaId") VALUES (1, 32), (1, 33), (2, 34), (1, 35);
INSERT INTO media_release_dates ("mediaId", kind, date) VALUES
 (29, 'physical', '2026-03-25'),
 (32, 'release', '2010-05-01'),
 (33, 'release', '2012-06-01'),
 (34, 'release', '2014-01-01'),
 (35, 'release', '2011-01-01'),
 (48, 'release', '2026-03-05'),
 (48, 'cinema', '2026-03-05'),
 (48, 'digital', '2026-03-20'),
 (48, 'physical', '2026-04-10'),
 (49, 'release', '2026-03-12'),
 (50, 'release', '2026-03-15'),
 (50, 'cinema', '2026-02-01');
INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES
 (21, 'movie', 'tmdb', '3021'),
 (21, 'movie', 'imdb', 'tt0000021'),
 (22, 'movie', 'tmdb', '3022'),
 (22, 'movie', 'imdb', 'tt0050083'),
 (23, 'movie', 'tmdb', '3023'),
 (24, 'movie', 'tmdb', '3024'),
 (25, 'movie', 'tmdb', '3025'),
 (26, 'movie', 'tmdb', '3026'),
 (29, 'movie', 'tmdb', '3029'),
 (30, 'movie', 'tmdb', '3030'),
 (31, 'movie', 'tmdb', '3031'),
 (32, 'movie', 'tmdb', '3032'),
 (33, 'movie', 'tmdb', '3033'),
 (34, 'movie', 'tmdb', '3034'),
 (35, 'movie', 'tmdb', '3035'),
 (36, 'movie', 'tmdb', '3036'),
 (37, 'movie', 'tmdb', '3037'),
 (38, 'movie', 'tmdb', '3038'),
 (39, 'movie', 'tmdb', '3039'),
 (40, 'movie', 'tmdb', '3040'),
 (41, 'movie', 'tmdb', '3041'),
 (42, 'movie', 'tmdb', '3042'),
 (43, 'series', 'tmdb', '4043'),
 (44, 'series', 'tmdb', '4044'),
 (45, 'series', 'tmdb', '4045'),
 (46, 'series', 'tmdb', '4046'),
 (47, 'series', 'tmdb', '4047'),
 (48, 'movie', 'tmdb', '3048'),
 (49, 'movie', 'tmdb', '3049'),
 (50, 'movie', 'tmdb', '3050'),
 (51, 'movie', 'tmdb', '3051');

-- distinct, non-id-ordered creation times so added/recently-added are deterministic
UPDATE media SET "createdAt" = '2026-01-01'::timestamptz + id * interval '1 day' WHERE id <= 20;
UPDATE media SET "posterUrl" = '/api/images/' || id || '/poster' WHERE id IN (21, 22, 24, 32, 33, 34);
UPDATE media SET "searchVector" = NULL WHERE id = 24;

-- the base movies' items move out of the episode id range the scenarios record
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE contype = 'f' AND confrelid IN ('items'::regclass, 'item_parts'::regclass) AND pg_get_constraintdef(oid) NOT LIKE '%ON UPDATE%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s ON UPDATE CASCADE', r.tbl, r.conname, r.def);
  END LOOP;
END $$;
UPDATE items SET id = -id WHERE "groupId" IS NULL;
INSERT INTO editions ("mediaId", family)
  SELECT id, 'video' FROM media m WHERE NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id) ORDER BY id;
INSERT INTO item_groups (id, "createdAt", "updatedAt", "number", monitored, "mediaId", "posterUrl", overview, "airDate") VALUES
 (7, '2026-01-01', '2026-01-01', 1, true, 43, '/api/images/43/season-1', 'Season one overview', '2022-01-01'),
 (8, '2026-01-01', '2026-01-01', 0, true, 43, NULL, NULL, NULL),
 (9, '2026-01-01', '2026-01-01', 2, false, 43, NULL, NULL, NULL),
 (10, '2026-01-01', '2026-01-01', 1, true, 44, NULL, NULL, NULL),
 (11, '2026-01-01', '2026-01-01', 2, true, 44, NULL, NULL, NULL),
 (12, '2026-01-01', '2026-01-01', 1, true, 45, NULL, NULL, NULL),
 (13, '2026-01-01', '2026-01-01', 1, true, 46, NULL, NULL, NULL),
 (14, '2026-01-01', '2026-01-01', 1, true, 47, NULL, NULL, NULL),
 (15, '2026-01-01', '2026-01-01', 0, true, 47, NULL, NULL, NULL),
 (16, '2026-01-01', '2026-01-01', 2, true, 47, NULL, NULL, NULL);
INSERT INTO items (id, "createdAt", "updatedAt", "number", "endNumber", title, "airDate", runtime, monitored, "stillUrl", "markersScannedAt", "groupId", "mediaId", "editionId") VALUES
 (13, '2026-01-01', '2026-01-01', 1, 2, 'Episode 1', '2000-01-01', 45, true, '/api/images/43/still-1', '2026-01-10T00:00:00Z', 7, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (14, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2000-01-01', NULL, true, NULL, NULL, 7, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (15, '2026-01-01', '2026-01-01', 3, NULL, 'Episode 3', '2000-01-01', NULL, false, NULL, NULL, 7, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (16, '2026-01-01', '2026-01-01', 4, NULL, 'Episode 4', '2099-01-01', NULL, true, NULL, NULL, 7, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (17, '2026-01-01', '2026-01-01', 1, NULL, 'Special', '2000-01-01', NULL, true, NULL, NULL, 8, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (18, '2026-01-01', '2026-01-01', 1, NULL, 'Episode 1', '2000-01-01', NULL, true, NULL, NULL, 9, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (19, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2000-01-01', NULL, true, NULL, NULL, 9, 43, (SELECT id FROM editions WHERE "mediaId" = 43)),
 (20, '2026-01-01', '2026-01-01', 1, 2, 'Episode 1', '2000-01-01', NULL, true, NULL, NULL, 10, 44, (SELECT id FROM editions WHERE "mediaId" = 44)),
 (21, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2000-01-01', NULL, true, NULL, NULL, 10, 44, (SELECT id FROM editions WHERE "mediaId" = 44)),
 (22, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2000-01-01', NULL, true, NULL, NULL, 11, 44, (SELECT id FROM editions WHERE "mediaId" = 44)),
 (23, '2026-01-01', '2026-01-01', 1, NULL, 'Episode 1', '2000-01-01', NULL, true, NULL, NULL, 12, 45, (SELECT id FROM editions WHERE "mediaId" = 45)),
 (24, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2000-01-01', NULL, true, NULL, NULL, 12, 45, (SELECT id FROM editions WHERE "mediaId" = 45)),
 (25, '2026-01-01', '2026-01-01', 3, NULL, 'Episode 3', '2000-01-01', NULL, true, NULL, NULL, 12, 45, (SELECT id FROM editions WHERE "mediaId" = 45)),
 (26, '2026-01-01', '2026-01-01', 1, NULL, 'Episode 1', '2000-01-01', NULL, true, NULL, NULL, 13, 46, (SELECT id FROM editions WHERE "mediaId" = 46)),
 (27, '2026-01-01', '2026-01-01', 1, NULL, 'Episode 1', '2026-03-03', NULL, true, NULL, NULL, 14, 47, (SELECT id FROM editions WHERE "mediaId" = 47)),
 (28, '2026-01-01', '2026-01-01', 2, NULL, 'Episode 2', '2026-03-10', NULL, false, NULL, NULL, 14, 47, (SELECT id FROM editions WHERE "mediaId" = 47)),
 (29, '2026-01-01', '2026-01-01', 3, 4, 'Episode 3', '2026-03-17', NULL, true, NULL, NULL, 14, 47, (SELECT id FROM editions WHERE "mediaId" = 47)),
 (30, '2026-01-01', '2026-01-01', 4, NULL, 'Episode 4', '2026-03-17', NULL, true, NULL, NULL, 14, 47, (SELECT id FROM editions WHERE "mediaId" = 47)),
 (31, '2026-01-01', '2026-01-01', 1, NULL, 'Calendar Special', '2026-03-07', NULL, true, NULL, NULL, 15, 47, (SELECT id FROM editions WHERE "mediaId" = 47)),
 (32, '2026-01-01', '2026-01-01', 1, NULL, 'Episode 1', NULL, NULL, true, NULL, NULL, 16, 47, (SELECT id FROM editions WHERE "mediaId" = 47));
INSERT INTO items (id, "mediaId", "editionId", monitored)
  SELECT -1000 - m.id, m.id, e.id, true FROM media m JOIN editions e ON e."mediaId" = m.id
  WHERE m.type = 'movie' AND NOT EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id) ORDER BY m.id;
INSERT INTO media_files (id, "createdAt", "updatedAt", "relativePath", size, quality, language, "streamInfo", "mediaId", "osdbHash", "osdbBytesize") VALUES
 (30, '2026-02-01'::timestamptz + (30 * 37 % 101) * interval '1 hour', '2026-01-01', 'alpha test (2020)/alpha test (2020).mkv', 1000030, 'WEBDL-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 21, '8e245d9679d31e12', 12345678901),
 (31, '2026-02-01'::timestamptz + (31 * 37 % 101) * interval '1 hour', '2026-01-01', '12 Angry Men (2020)/12 Angry Men (2020).mkv', 1000031, 'WEBDL-1080p', 'en', NULL, 22, NULL, NULL),
 (32, '2026-02-01'::timestamptz + (32 * 37 % 101) * interval '1 hour', '2026-01-01', 'Éclair (2020)/Éclair (2020).mkv', 1000032, 'WEBDL-1080p', 'en', NULL, 23, NULL, NULL),
 (33, '2026-02-01'::timestamptz + (33 * 37 % 101) * interval '1 hour', '2026-01-01', 'L''Impossible (2020)/L''Impossible (2020).mkv', 1000033, 'WEBDL-1080p', 'en', NULL, 24, NULL, NULL),
 (34, '2026-02-01'::timestamptz + (34 * 37 % 101) * interval '1 hour', '2026-01-01', 'Les Évadés (2020)/Les Évadés (2020).mkv', 1000034, 'WEBDL-1080p', 'en', NULL, 25, NULL, NULL),
 (35, '2026-02-01'::timestamptz + (35 * 37 % 101) * interval '1 hour', '2026-01-01', 'Zeta Alpha Alpha (2020)/Zeta Alpha Alpha (2020).mkv', 1000035, 'WEBDL-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 26, NULL, NULL),
 (36, '2026-02-01'::timestamptz + (36 * 37 % 101) * interval '1 hour', '2026-01-01', 'Unidentified Movie (2020)/Unidentified Movie (2020).mkv', 1000036, 'WEBDL-1080p', 'en', NULL, 27, NULL, NULL),
 (37, '2026-02-01'::timestamptz + (37 * 37 % 101) * interval '1 hour', '2026-01-01', 'Empty Imdb Movie (2020)/Empty Imdb Movie (2020).mkv', 1000037, 'WEBDL-1080p', 'en', NULL, 28, NULL, NULL),
 (38, '2026-02-01'::timestamptz + (38 * 37 % 101) * interval '1 hour', '2026-01-01', 'Unmonitored Movie (2020)/Unmonitored Movie (2020).mkv', 1000038, 'WEBDL-1080p', 'en', NULL, 29, NULL, NULL),
 (39, '2026-02-01'::timestamptz + (39 * 37 % 101) * interval '1 hour', '2026-01-01', 'Null Library Movie (2020)/Null Library Movie (2020).mkv', 1000039, 'WEBDL-1080p', 'en', NULL, 31, NULL, NULL),
 (40, '2026-02-01'::timestamptz + (40 * 37 % 101) * interval '1 hour', '2026-01-01', 'Collection Alpha 1 (2020)/Collection Alpha 1 (2020).mkv', 1000040, 'WEBDL-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 32, NULL, NULL),
 (41, '2026-02-01'::timestamptz + (41 * 37 % 101) * interval '1 hour', '2026-01-01', 'Collection Alpha 2 (2020)/Collection Alpha 2 (2020).mkv', 1000041, 'WEBDL-1080p', 'en', NULL, 33, NULL, NULL),
 (42, '2026-02-01'::timestamptz + (42 * 37 % 101) * interval '1 hour', '2026-01-01', 'Collection Solo (2020)/Collection Solo (2020).mkv', 1000042, 'WEBDL-1080p', 'en', NULL, 34, NULL, NULL),
 (43, '2026-02-01'::timestamptz + (43 * 37 % 101) * interval '1 hour', '2026-01-01', 'Collection Other Library (2020)/Collection Other Library (2020).mkv', 1000043, 'WEBDL-1080p', 'en', NULL, 35, NULL, NULL),
 (44, '2026-02-01'::timestamptz + (44 * 37 % 101) * interval '1 hour', '2026-01-01', 'Profile Movie Unmet (2020)/Profile Movie Unmet (2020).mkv', 1000044, 'WEBDL-720p', 'en', NULL, 36, NULL, NULL),
 (45, '2026-02-01'::timestamptz + (45 * 37 % 101) * interval '1 hour', '2026-01-01', 'Profile Movie Met (2020)/Profile Movie Met (2020).mkv', 1000045, 'Bluray-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 37, NULL, NULL),
 (46, '2026-02-01'::timestamptz + (46 * 37 % 101) * interval '1 hour', '2026-01-01', 'Profile Movie Empty Quality (2020)/Profile Movie Empty Quality (2020).mkv', 1000046, '', 'en', NULL, 38, NULL, NULL),
 (47, '2026-02-01'::timestamptz + (47 * 37 % 101) * interval '1 hour', '2026-01-01', 'Profile Movie 8K (2020)/Profile Movie 8K (2020).mkv', 1000047, '4320p WEB-DL', 'en', NULL, 39, NULL, NULL),
 (48, '2026-02-01'::timestamptz + (48 * 37 % 101) * interval '1 hour', '2026-01-01', 'Unknown Cutoff Movie (2020)/Unknown Cutoff Movie (2020).mkv', 1000048, 'WEBDL-1080p', 'en', NULL, 40, NULL, NULL),
 (49, '2026-02-01'::timestamptz + (49 * 37 % 101) * interval '1 hour', '2026-01-01', 'Language Profile Movie (2020)/Language Profile Movie (2020).mkv', 1000049, 'WEBDL-1080p', 'en', NULL, 41, NULL, NULL),
 (50, '2026-02-01'::timestamptz + (50 * 37 % 101) * interval '1 hour', '2026-01-01', 'Pathless Library Movie (2020)/Pathless Library Movie (2020).mkv', 1000050, 'WEBDL-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 42, NULL, NULL),
 (51, '2026-02-01'::timestamptz + (51 * 37 % 101) * interval '1 hour', '2026-01-01', 'Cal Movie Cinema Digital (2020)/Cal Movie Cinema Digital (2020).mkv', 1000051, 'WEBDL-1080p', 'en', NULL, 48, NULL, NULL),
 (52, '2026-02-01'::timestamptz + (52 * 37 % 101) * interval '1 hour', '2026-01-01', 'Cal Movie Release Only (2020)/Cal Movie Release Only (2020).mkv', 1000052, 'WEBDL-1080p', 'en', NULL, 49, NULL, NULL),
 (53, '2026-02-01'::timestamptz + (53 * 37 % 101) * interval '1 hour', '2026-01-01', 'Cal Movie Release Inside Cinema Outside (2020)/Cal Movie Release Inside Cinema Outside (2020).mkv', 1000053, 'WEBDL-1080p', 'en', NULL, 50, NULL, NULL),
 (54, '2026-02-01'::timestamptz + (54 * 37 % 101) * interval '1 hour', '2026-01-01', 'No Signal Movie (2020)/No Signal Movie (2020).mkv', 1000054, 'WEBDL-1080p', 'en', NULL, 51, NULL, NULL),
 (55, '2026-02-01'::timestamptz + (55 * 37 % 101) * interval '1 hour', '2026-01-01', 'Profile Movie Met (2020)/Profile Movie Met (2020).720.mkv', 1000055, 'HDTV-720p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 37, NULL, NULL),
 (56, '2026-02-01'::timestamptz + (56 * 37 % 101) * interval '1 hour', '2026-01-01', 'alpha test (2020)/alpha test (2020).720.mkv', 1000056, 'Bluray-720p', NULL, NULL, 21, NULL, NULL),
 (57, '2026-02-01'::timestamptz + (57 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e13.mkv', 1000057, 'WEBDL-720p', 'en', NULL, 43, NULL, NULL),
 (58, '2026-02-01'::timestamptz + (58 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e20.mkv', 1000058, 'Bluray-1080p', 'en', NULL, 44, NULL, NULL),
 (59, '2026-02-01'::timestamptz + (59 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e23.mkv', 1000059, 'WEBDL-1080p', 'en', NULL, 45, NULL, NULL),
 (60, '2026-02-01'::timestamptz + (60 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e24.mkv', 1000060, 'WEBDL-1080p', 'en', '{"video": [], "audio": [], "subtitles": []}'::jsonb, 45, NULL, NULL),
 (61, '2026-02-01'::timestamptz + (61 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e27.mkv', 1000061, 'WEBDL-1080p', 'en', NULL, 47, NULL, NULL),
 (62, '2026-02-01'::timestamptz + (62 * 37 % 101) * interval '1 hour', '2026-01-01', 'Season 01/e29.mkv', 1000062, 'WEBDL-1080p', 'en', NULL, 47, NULL, NULL);
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
  SELECT i.id, f.id, f."mediaId", (row_number() OVER (PARTITION BY i.id ORDER BY f.id) - 1)::int FROM media_files f
  JOIN items i ON i."mediaId" = f."mediaId" AND i."groupId" IS NULL WHERE f.id BETWEEN 30 AND 56;
-- a multi-episode file (13, 20, 29) plays the item inside its range
INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") VALUES
 (13, 57, 43, 0), (14, 57, 43, 0), (20, 58, 44, 0), (21, 58, 44, 0), (23, 59, 45, 0), (24, 60, 45, 0),
 (27, 61, 47, 0), (29, 62, 47, 0), (30, 62, 47, 0);

INSERT INTO movie_details (id, "createdAt", "updatedAt", budget, revenue, tagline, popularity, "voteCount", "originalLanguage", "productionCountries", "productionCompanies", videos, keywords, "mediaId") VALUES
 (1, '2026-01-01', '2026-01-01', 150000000000, 9007199254740993, 'A tagline', 12.5, 1234, 'en', '[{"iso_3166_1":"US","name":"United States"}]', '[{"id":1,"name":"Studio"}]', '[{"key":"abc","site":"YouTube"}]', '["heist","space"]', 3),
 (2, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["heist"]', 5),
 (3, '2026-01-01', '2026-01-01', 0, 0, NULL, 1.5, 10, 'fr', '[]', '[]', '[]', '["space","war"]', 7),
 (4, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["love"]', 9),
 (5, '2026-01-01', '2026-01-01', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["Heist"]', 13);
INSERT INTO persons (id, "createdAt", "updatedAt", name, "avatarUrl", biography, birthday, deathday, "placeOfBirth", "knownForDepartment", departments, "metadataRefreshedAt") VALUES
 (1, '2026-01-01', '2026-01-01', 'Alice Actor', '/api/persons/1/avatar', 'Biography of Alice', '1980-02-03', NULL, 'Paris', 'Acting', '["Acting"]', '2026-01-05T10:00:00Z'),
 (2, '2026-01-01', '2026-01-01', 'Bob Actor', NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL),
 (3, '2026-01-01', '2026-01-01', 'Carol Director', NULL, NULL, '1970-07-08', '2020-01-02', 'Lyon', 'Directing', '["Directing","Writing"]', NULL),
 (4, '2026-01-01', '2026-01-01', 'Dan Director', NULL, NULL, NULL, NULL, NULL, 'Directing', '["Directing"]', NULL);
INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'tmdb', '101'), (2, 'tmdb', '102'), (3, 'tmdb', '103'), (4, 'tmdb', '104');
INSERT INTO media_credits (id, "createdAt", "updatedAt", role, character, position, "mediaId", "personId") VALUES
 (1, '2026-01-01', '2026-01-01', 'cast', 'Hero', 0, 3, 1),
 (2, '2026-01-01', '2026-01-01', 'cast', 'Villain', 1, 3, 2),
 (3, '2026-01-01', '2026-01-01', 'cast', 'Cameo', 1, 3, 3);
INSERT INTO media_credits (id, "createdAt", "updatedAt", role, job, department, position, "mediaId", "personId") VALUES
 (4, '2026-01-01', '2026-01-01', 'crew', 'Director', 'Directing', 0, 3, 3),
 (5, '2026-01-01', '2026-01-01', 'crew', 'Writer', 'Writing', 1, 3, 1),
 (6, '2026-01-01', '2026-01-01', 'crew', 'Director', 'Directing', 0, 5, 3),
 (7, '2026-01-01', '2026-01-01', 'crew', 'Producer', 'Production', 0, 9, 3),
 (8, '2026-01-01', '2026-01-01', 'crew', 'Director', 'Directing', 0, 11, 4),
 (9, '2026-01-01', '2026-01-01', 'crew', 'Director', 'Directing', 0, 23, 4);


INSERT INTO playback_states ("createdAt", "updatedAt", "positionSeconds", "durationSeconds", completed, "lastPlayedAt", "playedAt", "userId", "itemId", "mediaFileId") VALUES
 ('2026-02-01', '2026-02-01', 450, 3600, false, '2026-02-01', NULL, 2, (SELECT id FROM items WHERE "mediaId" = 6 AND "groupId" IS NULL), 6),
 ('2026-02-01', '2026-02-01', 3500, 3600, true, '2026-02-03', '2026-02-03', 2, (SELECT id FROM items WHERE "groupId" = (SELECT id FROM item_groups WHERE "mediaId" = 44 AND "number" = 1) AND "number" = 1), 58),
 -- finishing the range file of episode 1 completes episode 2 with it
 ('2026-02-01', '2026-02-01', 0, 3600, true, '2026-02-03', NULL, 2, 21, 58),
 ('2026-02-01', '2026-02-01', 1700, 1800, true, '2026-02-04', '2026-02-04', 2, 23, 59),
 ('2026-02-01', '2026-02-01', 200, 1800, false, '2026-02-05', NULL, 2, 24, 60);

UPDATE media SET "searchVector" = NULL WHERE id = 24;
ALTER TABLE media ENABLE TRIGGER set_updated_at;
ALTER TABLE media_files ENABLE TRIGGER set_updated_at;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id' AND column_default LIKE 'nextval%' LOOP
    EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, ''id''), COALESCE((SELECT max(id) FROM %I), 1), (SELECT count(*) > 0 FROM %I))', r.t, r.t, r.t);
  END LOOP;
END $$;
SELECT setval('media_details_id_seq', GREATEST((SELECT max(id) FROM movie_details), (SELECT max(id) FROM series_details), 1));
