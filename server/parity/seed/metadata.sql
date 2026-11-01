-- Parity seed delta "metadata" (docs/spec/metadata.md and persons.md Vectors/parity), applied on top of base.sql.
-- Series library prefers TVDB; media 19 shares tmdb id 1001 with movie 1 (kind collision); persons cover fresh,
-- stale and never-refreshed rows. Refresh times are relative to the template build.
ALTER TABLE libraries DISABLE TRIGGER set_updated_at;
UPDATE libraries SET "preferredProvider" = 'tvdb' WHERE id = 2;
ALTER TABLE libraries ENABLE TRIGGER set_updated_at;
INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES
 (18, 'series', 'tvdb', '81189'),
 (19, 'series', 'tmdb', '1001')
ON CONFLICT ("mediaId", provider) DO UPDATE SET value = EXCLUDED.value;

INSERT INTO persons (id, "createdAt", "updatedAt", name, "avatarUrl", biography, birthday, deathday, "placeOfBirth", "knownForDepartment", departments, "metadataRefreshedAt") VALUES
 (1, '2026-01-01', '2026-01-01', 'Claire Danes', '/api/images/person/1', 'Fresh bio', '1979-04-12', NULL, 'New York', 'Acting', '["Acting"]', now()),
 (2, '2026-01-01', '2026-01-01', 'Claude Rains', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days'),
 (3, '2026-01-01', '2026-01-01', 'Conan O''Brien', NULL, NULL, '1963-04-18', NULL, 'Brookline', NULL, '[]', NULL),
 (4, '2026-01-01', '2026-01-01', 'Jean-Luc Godard', NULL, 'Director', NULL, '2022-09-13', NULL, 'Directing', '["Directing"]', now()),
 (5, '2026-01-01', '2026-01-01', 'Amélie Poulain', NULL, NULL, NULL, NULL, NULL, 'Acting', '[]', now()),
 (6, '2026-01-01', '2026-01-01', 'Tvdb Actor', NULL, NULL, NULL, NULL, NULL, NULL, '[]', now() - interval '30 days'),
 (7, '2026-01-01', '2026-01-01', 'Clara Fallback', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days'),
 (8, '2026-01-01', '2026-01-01', 'Provider Fail', NULL, 'Stored bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days'),
 (9, '2026-01-01', '2026-01-01', 'Shared Id', NULL, 'Fresh bio', NULL, NULL, NULL, 'Acting', '[]', now()),
 (10, '2026-01-01', '2026-01-01', 'Missing Avatar', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days');
INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'tmdb', '101'), (2, 'tmdb', '102'), (3, 'tmdb', '103'), (4, 'tmdb', '104'), (5, 'tmdb', '105'), (6, 'tvdb', '5555'), (7, 'tmdb', '777'), (8, 'tmdb', '888'), (9, 'tmdb', '603'), (10, 'tmdb', '1010');
ALTER TABLE persons DISABLE TRIGGER set_updated_at;
-- the insert trigger indexed every row; person 5 stays never-indexed (persons.md rule 6)
UPDATE persons SET "searchVector" = NULL WHERE id = 5;
ALTER TABLE persons ENABLE TRIGGER set_updated_at;
SELECT setval('persons_id_seq', 10);

INSERT INTO media_credits (id, "createdAt", "updatedAt", role, character, position, "mediaId", "personId") VALUES
 (1, '2026-01-01', '2026-01-01', 'cast', 'Lead', 0, 1, 1), (2, '2026-01-01', '2026-01-01', 'cast', 'Guest', 1, 18, 1),
 (3, '2026-01-01', '2026-01-01', 'cast', 'Second', 0, 2, 1), (4, '2026-01-01', '2026-01-01', 'cast', 'Neo', 0, 1, 9);
INSERT INTO media_credits (id, "createdAt", "updatedAt", role, job, department, position, "mediaId", "personId") VALUES
 (5, '2026-01-01', '2026-01-01', 'crew', 'Director', 'Directing', 0, 3, 1),
 (6, '2026-01-01', '2026-01-01', 'crew', 'Writer', 'Writing', 0, 19, 1);
SELECT setval('media_credits_id_seq', 6);
