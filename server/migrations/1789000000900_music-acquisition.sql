-- Which release groups and releases a library of albums wants (NULL: the default profile, `music.md` rule 44)
ALTER TABLE "libraries"
  ADD COLUMN "metadataProfile" jsonb CONSTRAINT "CK_libraries_metadataProfile"
    CHECK ("metadataProfile" IS NULL OR jsonb_typeof("metadataProfile") = 'object');

-- MP3-320 and MP3-V0 (ids 116, 117) were part of the MP3-256k bucket: an audio profile that allowed it allows both
ALTER TABLE "quality_profiles" DISABLE TRIGGER set_updated_at;
UPDATE "quality_profiles" p SET "items" = p."items" || (
  SELECT jsonb_agg(jsonb_set(jsonb_set(src.e, '{quality,id}', to_jsonb(n.id)), '{quality,name}', to_jsonb(n.name)))
  FROM (SELECT t.e FROM jsonb_array_elements(p."items") AS t(e)
         WHERE (t.e->'quality'->>'id')::int = 104 AND (t.e->>'allowed')::boolean LIMIT 1) src,
       (VALUES (116, 'MP3-320'), (117, 'MP3-V0')) AS n(id, name))
WHERE p."family" = 'audio'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(p."items") e
               WHERE (e->'quality'->>'id')::int = 104 AND (e->>'allowed')::boolean)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p."items") e WHERE (e->'quality'->>'id')::int = 116);
ALTER TABLE "quality_profiles" ENABLE TRIGGER set_updated_at;

-- The two rows reach a database whose audio definitions were seeded already (a fresh one seeds all of them)
INSERT INTO "quality_definitions" ("family", "qualityId", "title", "minSize", "preferredSize", "maxSize")
SELECT 'audio', v.id, v.title, v.min, v.preferred, v.max
FROM (VALUES (116, 'MP3-320', 80.0, 150.0, 320.0), (117, 'MP3-V0', 60.0, 130.0, 270.0)) AS v(id, title, min, preferred, max)
WHERE EXISTS (SELECT 1 FROM "quality_definitions" WHERE "family" = 'audio')
ON CONFLICT ("family", "qualityId") DO NOTHING;
