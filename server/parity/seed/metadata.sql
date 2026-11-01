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

INSERT INTO persons (id, "createdAt", "updatedAt", "tmdbId", name, "avatarUrl", biography, birthday, deathday, "placeOfBirth", "knownForDepartment", departments, "metadataRefreshedAt", provider) VALUES
 (1, '2026-01-01', '2026-01-01', 101, 'Claire Danes', '/api/images/person/1', 'Fresh bio', '1979-04-12', NULL, 'New York', 'Acting', '["Acting"]', now(), 'tmdb'),
 (2, '2026-01-01', '2026-01-01', 102, 'Claude Rains', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days', 'tmdb'),
 (3, '2026-01-01', '2026-01-01', 103, 'Conan O''Brien', NULL, NULL, '1963-04-18', NULL, 'Brookline', NULL, '[]', NULL, 'tmdb'),
 (4, '2026-01-01', '2026-01-01', 104, 'Jean-Luc Godard', NULL, 'Director', NULL, '2022-09-13', NULL, 'Directing', '["Directing"]', now(), 'tmdb'),
 (5, '2026-01-01', '2026-01-01', 105, 'Amélie Poulain', NULL, NULL, NULL, NULL, NULL, 'Acting', '[]', now(), 'tmdb'),
 (6, '2026-01-01', '2026-01-01', 5555, 'Tvdb Actor', NULL, NULL, NULL, NULL, NULL, NULL, '[]', now() - interval '30 days', 'tvdb'),
 (7, '2026-01-01', '2026-01-01', 777, 'Clara Fallback', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days', 'tmdb'),
 (8, '2026-01-01', '2026-01-01', 888, 'Provider Fail', NULL, 'Stored bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days', 'tmdb'),
 (9, '2026-01-01', '2026-01-01', 603, 'Shared Id', NULL, 'Fresh bio', NULL, NULL, NULL, 'Acting', '[]', now(), 'tmdb'),
 (10, '2026-01-01', '2026-01-01', 1010, 'Missing Avatar', NULL, 'Old bio', NULL, NULL, NULL, 'Acting', '[]', now() - interval '30 days', 'tmdb');
ALTER TABLE persons DISABLE TRIGGER set_updated_at;
-- the insert trigger indexed every row; person 5 stays never-indexed (persons.md rule 6)
UPDATE persons SET "searchVector" = NULL WHERE id = 5;
ALTER TABLE persons ENABLE TRIGGER set_updated_at;
SELECT setval('persons_id_seq', 10);

INSERT INTO media_cast (id, "createdAt", "updatedAt", character, "order", "mediaId", "personId") VALUES
 (1, '2026-01-01', '2026-01-01', 'Lead', 0, 1, 1), (2, '2026-01-01', '2026-01-01', 'Guest', 1, 18, 1),
 (3, '2026-01-01', '2026-01-01', 'Second', 0, 2, 1), (4, '2026-01-01', '2026-01-01', 'Neo', 0, 1, 9);
INSERT INTO media_crew (id, "createdAt", "updatedAt", job, department, "mediaId", "personId") VALUES
 (1, '2026-01-01', '2026-01-01', 'Director', 'Directing', 3, 1), (2, '2026-01-01', '2026-01-01', 'Writer', 'Writing', 19, 1);
SELECT setval('media_cast_id_seq', 4), setval('media_crew_id_seq', 2);
