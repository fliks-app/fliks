-- A provider source is `provider:` plus a core name or a plugin namespace (provider-plugins.md rule 22); one preferred row per layer
ALTER TABLE "lyrics" DROP CONSTRAINT "CK_lyrics_source";
ALTER TABLE "lyrics" ADD CONSTRAINT "CK_lyrics_source" CHECK (
  length("source") <= 93
  AND "source" ~ '^(embedded|sidecar|user|generated|provider:([a-z][a-z0-9]{1,31}|[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}))$'
);

ALTER TABLE "lyrics" DISABLE TRIGGER set_updated_at;
UPDATE "lyrics" SET "preferred" = false
  WHERE "preferred" AND "id" NOT IN (SELECT max("id") FROM "lyrics" WHERE "preferred" GROUP BY "itemId", "kind", "lang");
ALTER TABLE "lyrics" ENABLE TRIGGER set_updated_at;
CREATE UNIQUE INDEX "UQ_lyrics_preferred" ON "lyrics" ("itemId", "kind", "lang") WHERE "preferred";
