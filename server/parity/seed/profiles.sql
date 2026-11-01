-- Parity seed delta "profiles" (docs/spec/profiles.md Vectors/parity), applied on top of base.sql by the runner.
-- settings actor: settings.access only (the non-admin write path of custom formats and definitions).
INSERT INTO roles (id, "createdAt", "updatedAt", name, permissions, "isDefault") VALUES (5, '2026-01-01', '2026-01-01', 'Settings', '["settings.access"]', false);
INSERT INTO users (id, "createdAt", "updatedAt", username, email, "passwordHash", "roleId", "isAdmin") VALUES
 (6, '2026-01-01', '2026-01-01', 'settings', 'settings@parity.test', '$2b$10$dHgV4KDAYShlxrhE/Plnte19kxC1Oq7zlPFHYN168N4tDDla9o4la', 5, false);

INSERT INTO quality_profiles (id, "createdAt", "updatedAt", name, cutoff, items, "upgradeAllowed", "resolutionUpgradeOnly", "minCustomFormatScore") VALUES
 (1, '2026-01-01', '2026-01-01', 'Parity HD', 18,
  '[{"quality":{"id":16,"name":"WEBDL-1080p","resolution":1080,"source":"web"},"allowed":true,"sortOrder":1,"groupId":1},{"quality":{"id":17,"name":"WEBRip-1080p","resolution":1080,"source":"web"},"allowed":true,"sortOrder":2,"groupId":1},{"quality":{"id":18,"name":"Bluray-1080p","resolution":1080,"source":"bluray"},"allowed":true,"sortOrder":3}]',
  true, false, 10),
 (2, '2026-01-01', '2026-01-01', 'Parity SD', 5,
  '[{"quality":{"id":5,"name":"DVD","resolution":480,"source":"dvd"},"allowed":true,"sortOrder":1}]',
  false, true, 0);
SELECT setval('quality_profiles_id_seq', 2);

INSERT INTO language_profiles (id, "createdAt", "updatedAt", name, "audioLanguages", "subtitleLanguages") VALUES
 (2, '2026-01-01', '2026-01-01', 'Parity FR',
  '[{"isoCode":"fr","name":"French"},{"isoCode":"en","name":"English"}]',
  '[{"isoCode":"fr","name":"French","forced":false,"hi":false,"hearingImpaired":"prefer"},{"isoCode":"en","name":"English","forced":true,"hi":false}]'),
 (3, '2026-01-01', '2026-01-01', 'Parity Null Mode',
  '[{"isoCode":"en","name":"English"}]',
  '[{"isoCode":"en","name":"English","forced":false,"hi":true,"hearingImpaired":null}]');
SELECT setval('language_profiles_id_seq', 3);

INSERT INTO custom_formats (id, "createdAt", "updatedAt", name, score, specs) VALUES
 (1, '2026-01-01', '2026-01-01', 'Remux regex', 50, '[{"type":"title_regex","value":"remux","negate":false,"required":false}]'),
 (2, '2026-01-01', '2026-01-01', 'No CAM', -100, '[{"type":"source","value":"cam","negate":true,"required":false}]'),
 (3, '2026-01-01', '2026-01-01', 'Freeleech only', 5, '[{"type":"release_flag","value":"freeleech","negate":false,"required":true},{"type":"resolution","value":"1080","negate":false,"required":false}]'),
 (4, '2026-01-01', '2026-01-01', 'Broken negated regex', 7, '[{"type":"title_regex","value":"(","negate":true,"required":false}]');
SELECT setval('custom_formats_id_seq', 4);

-- references that a delete must null (rule 11)
ALTER TABLE libraries DISABLE TRIGGER set_updated_at;
ALTER TABLE media DISABLE TRIGGER set_updated_at;
ALTER TABLE wants DISABLE TRIGGER set_updated_at;
ALTER TABLE requests DISABLE TRIGGER set_updated_at;
UPDATE libraries SET "defaultQualityProfileId" = 1, "defaultLanguageProfileId" = 2 WHERE id = 1;
UPDATE media SET "languageProfileId" = 2 WHERE id = 1;
UPDATE wants SET "qualityProfileId" = 1 WHERE "mediaId" = 1 AND family = 'video';
UPDATE requests SET "qualityProfileId" = 1, "languageProfileId" = 2 WHERE id = 1;
ALTER TABLE libraries ENABLE TRIGGER set_updated_at;
ALTER TABLE media ENABLE TRIGGER set_updated_at;
ALTER TABLE wants ENABLE TRIGGER set_updated_at;
ALTER TABLE requests ENABLE TRIGGER set_updated_at;
