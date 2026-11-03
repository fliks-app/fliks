INSERT INTO "quality_definitions" ("family", "qualityId", "title", "minSize", "preferredSize", "maxSize")
SELECT 'text', v.id, v.title, 0, v.preferred, v.max
FROM (VALUES (206, 'FB2', 2, 50), (207, 'CBZ', 50, 500)) AS v(id, title, preferred, max)
WHERE EXISTS (SELECT 1 FROM "quality_definitions" WHERE "family" = 'text')
ON CONFLICT ("family", "qualityId") DO NOTHING;
