CREATE TEMP TABLE "_artist_merge" ON COMMIT DROP AS
SELECT p.id AS "fromId", (array_agg(q.id))[1] AS "toId"
FROM persons p
JOIN persons q ON name_key(q.name) = name_key(p.name) AND q.id <> p.id
 AND EXISTS (SELECT 1 FROM person_external_ids x WHERE x."personId" = q.id AND x.provider = 'musicbrainz')
WHERE NOT EXISTS (SELECT 1 FROM person_external_ids x WHERE x."personId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM person_external_id_aliases x WHERE x."personId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM media_credits c JOIN media m ON m.id = c."mediaId"
                   WHERE c."personId" = p.id AND m.type IN ('movie', 'series'))
GROUP BY p.id
HAVING count(*) = 1;

ALTER TABLE item_credits DISABLE TRIGGER set_updated_at;
ALTER TABLE media_credits DISABLE TRIGGER set_updated_at;
ALTER TABLE person_follows DISABLE TRIGGER set_updated_at;
ALTER TABLE works DISABLE TRIGGER set_updated_at;

DELETE FROM item_credits c USING "_artist_merge" m
WHERE c."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM item_credits d WHERE d."personId" = m."toId" AND d."itemId" = c."itemId" AND d.role = c.role);
UPDATE item_credits c SET "personId" = m."toId" FROM "_artist_merge" m WHERE c."personId" = m."fromId";

DELETE FROM media_credits c USING "_artist_merge" m
WHERE c."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM media_credits d WHERE d."personId" = m."toId" AND d."mediaId" = c."mediaId"
                AND d."editionId" IS NOT DISTINCT FROM c."editionId" AND d.role = c.role);
UPDATE media_credits c SET "personId" = m."toId" FROM "_artist_merge" m WHERE c."personId" = m."fromId";

DELETE FROM person_follows f USING "_artist_merge" m
WHERE f."personId" = m."fromId"
  AND EXISTS (SELECT 1 FROM person_follows d WHERE d."personId" = m."toId" AND d."userId" = f."userId" AND d.role = f.role);
UPDATE person_follows f SET "personId" = m."toId" FROM "_artist_merge" m WHERE f."personId" = m."fromId";

UPDATE works w SET "composerPersonId" = m."toId" FROM "_artist_merge" m WHERE w."composerPersonId" = m."fromId";

ALTER TABLE item_credits ENABLE TRIGGER set_updated_at;
ALTER TABLE media_credits ENABLE TRIGGER set_updated_at;
ALTER TABLE person_follows ENABLE TRIGGER set_updated_at;
ALTER TABLE works ENABLE TRIGGER set_updated_at;

DELETE FROM persons WHERE id IN (SELECT "fromId" FROM "_artist_merge");
