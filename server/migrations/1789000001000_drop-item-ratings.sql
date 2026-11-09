-- Per-track star ratings are gone: drop the table and the `rating` criteria and sort of smart playlists.
-- A smart playlist left with no criterion becomes a static empty one, and a `rating` sort falls back to `title`.
DROP TABLE "item_ratings";

ALTER TABLE "playlists" DISABLE TRIGGER set_updated_at;

UPDATE "playlists" SET "rules" = jsonb_set(
  CASE WHEN "rules"->'sort'->>'by' = 'rating' THEN jsonb_set("rules", '{sort,by}', '"title"') ELSE "rules" END,
  '{criteria}',
  COALESCE((SELECT jsonb_agg(c) FROM jsonb_array_elements("rules"->'criteria') c WHERE c->>'type' <> 'rating'), '[]'::jsonb)
)
WHERE "rules" IS NOT NULL
  AND ("rules"->'sort'->>'by' = 'rating'
       OR EXISTS (SELECT 1 FROM jsonb_array_elements("rules"->'criteria') c WHERE c->>'type' = 'rating'));

UPDATE "playlists" SET "rules" = NULL WHERE "rules" IS NOT NULL AND jsonb_array_length("rules"->'criteria') = 0;

ALTER TABLE "playlists" ENABLE TRIGGER set_updated_at;
