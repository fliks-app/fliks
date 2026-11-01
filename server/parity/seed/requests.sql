-- Parity seed delta "requests" (docs/spec/requests.md Vectors/parity), applied on top of base.sql by the runner.
-- validator actor: requests.manage on the two movie libraries; `other` has a movie quota of 1 and one fresh movie request.
INSERT INTO roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") VALUES
 (5, '2026-01-01', '2026-01-01', 'Validator', '["media.read","requests.create","requests.manage"]', false);
INSERT INTO users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "isAdmin") VALUES
 (6, '2026-01-01', '2026-01-01', 'validator', 'validator@parity.test', '$2b$10$QqKxvC..siIi7O4vTWwwpOKQoFL65PNMJ68uix7h6yDYu01SPUBu6', 5, false);
INSERT INTO libraries (id, "createdAt", "updatedAt", name, icon, color, "mediaTypes", path) VALUES
 (3, '2026-01-01', '2026-01-01', 'More Movies', 'film', '#ef4444', '["movie"]', '/tmp/fliks-parity/s5-requests/media/more');
SELECT setval('libraries_id_seq', 3);
INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 6), (3, 6);

INSERT INTO quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items, "upgradeAllowed", "resolutionUpgradeOnly", "minCustomFormatScore") VALUES
 (1, '2026-01-01', '2026-01-01', 'Parity HD', 18,
  '[{"quality":{"id":16,"name":"WEBDL-1080p","resolution":1080,"source":"web"},"allowed":true,"sortOrder":1}]', true, false, 0);
INSERT INTO language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") VALUES
 (2, '2026-01-01', '2026-01-01', 'Parity FR', '[{"isoCode":"fr","name":"French"}]', '[]');
SELECT setval('quality_profiles_id_seq', 1);
SELECT setval('language_profiles_id_seq', 2);

ALTER TABLE users DISABLE TRIGGER set_updated_at;
UPDATE users SET "movieQuotaLimit" = 1, "quotaPeriodDays" = 7 WHERE id = 4;
ALTER TABLE users ENABLE TRIGGER set_updated_at;

INSERT INTO requests (id, "createdAt", "updatedAt", "mediaType", kind, provider, "externalId", title, status, "declinedReason", seasons,
                      "userId", "approvedById", "qualityProfileId", "languageProfileId", "libraryId", "mediaId", "posterUrl", "fanartUrl") VALUES
 (3, '2026-01-02', '2026-01-02', 'movie', 'add', 'tmdb', '9003', 'Declined Movie', 'declined', 'Not now', NULL, 2, 1, NULL, NULL, 1, NULL, NULL, NULL),
 (4, '2026-01-03', '2026-01-03', 'series', 'add', 'tmdb', '9004', 'Seasons Series', 'pending', NULL, '[1,2]', 2, NULL, 1, 2, 2, NULL, '/api/images/request/series-9004/poster', NULL),
 (5, '2026-01-04', '2026-01-04', 'series', 'add', 'tmdb', '9005', 'Whole Series', 'pending', NULL, NULL, 4, NULL, NULL, NULL, 2, NULL, NULL, NULL),
 (6, '2026-01-05', '2026-01-05', 'movie', 'add', 'tmdb', '1001', 'Parity Movie 01', 'available', NULL, NULL, 2, 1, NULL, NULL, 1, 1, NULL, NULL),
 (7, '2026-01-06', '2026-01-06', 'movie', 'add', 'tmdb', '1002', 'Parity Movie 02', 'pending', NULL, NULL, 2, NULL, NULL, NULL, 1, NULL, NULL, NULL),
 (8, '2026-01-07', '2026-01-07', 'movie', 'add', 'tmdb', '9008', 'Unassigned Movie', 'pending', NULL, NULL, 4, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
 (9, '2026-01-08', '2026-01-08', 'movie', 'delete', 'tmdb', '1003', 'Parity Movie 03', 'pending', NULL, NULL, 2, NULL, NULL, NULL, 1, 3, NULL, NULL),
 (10, now() - interval '1 hour', now() - interval '1 hour', 'movie', 'add', 'tmdb', '9010', 'Recent Movie', 'pending', NULL, NULL, 4, NULL, NULL, NULL, 1, NULL, NULL, NULL);
SELECT setval('requests_id_seq', 10);

INSERT INTO request_comments (id, "createdAt", "updatedAt", message, "requestId", "userId") VALUES
 (1, '2026-01-02 10:00', '2026-01-02 10:00', 'First comment', 1, 2),
 (2, '2026-01-02 11:00', '2026-01-02 11:00', 'Admin reply', 1, 1);
SELECT setval('request_comments_id_seq', 2);

INSERT INTO auto_approval_rules (id, "createdAt", "updatedAt", name, enabled, criteria) VALUES
 (1, '2026-01-01', '2026-01-01', 'Disabled everything', false, '{}'),
 (2, '2026-01-01', '2026-01-01', 'Nobody', true, '{"userIds":[999]}'),
 (3, '2026-01-01', '2026-01-01', 'Anime series', true, '{"genreIds":[16],"mediaType":"series","maxSeasons":3,"yearFrom":2000}');
SELECT setval('auto_approval_rules_id_seq', 3);
