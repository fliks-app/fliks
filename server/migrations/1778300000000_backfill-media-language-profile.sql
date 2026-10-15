INSERT INTO "language_profiles"
  ("name", "audioLanguages", "subtitleLanguages", "createdAt", "updatedAt")
SELECT 'Toutes les langues (défaut)', '[]', '[]', now(), now()
WHERE (SELECT COUNT(*)::int FROM "language_profiles") = 0;

UPDATE "media"
   SET "languageProfileId" = (
     SELECT id FROM "language_profiles" ORDER BY id ASC LIMIT 1
   )
 WHERE "languageProfileId" IS NULL;
