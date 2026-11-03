-- Plugin namespaces (`<pluginId>:<name>`, `provider-plugins.md` 5.1): ownership is frozen by signer.
CREATE TABLE "provider_namespaces" (
  "name" text PRIMARY KEY,
  "pluginId" text NOT NULL,
  "signerKeyId" text,
  "idPattern" text NOT NULL,
  "case" text NOT NULL,
  "label" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_provider_namespaces_name" CHECK (
    octet_length("name") <= 84
    AND "name" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$'
    AND split_part("name", ':', 1) = "pluginId"),
  CONSTRAINT "CK_provider_namespaces_idPattern" CHECK (char_length("idPattern") BETWEEN 1 AND 256),
  CONSTRAINT "CK_provider_namespaces_case" CHECK ("case" IN ('preserve', 'lower', 'upper')),
  CONSTRAINT "CK_provider_namespaces_label" CHECK (char_length("label") BETWEEN 1 AND 64)
);
CREATE INDEX "IDX_provider_namespaces_pluginId" ON "provider_namespaces" ("pluginId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "provider_namespaces" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The closed provider lists become a shape check: a core name or a plugin namespace. Whether a bare
-- name belongs to the core is checked in Rust on write. A plugin's ids are 1 to 128 characters.
-- Every stored id still passes: the old lists were bare names of this shape.
ALTER TABLE "media_external_ids" DROP CONSTRAINT "CK_media_external_ids_provider",
  ADD CONSTRAINT "CK_media_external_ids_provider" CHECK (
    octet_length("provider") <= 84
    AND ("provider" ~ '^[a-z][a-z0-9]{1,31}$'
      OR "provider" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$')),
  ADD CONSTRAINT "CK_media_external_ids_plugin_value" CHECK (
    "provider" NOT LIKE '%:%' OR char_length("value") BETWEEN 1 AND 128);

ALTER TABLE "requests" DROP CONSTRAINT "CK_requests_provider",
  ADD CONSTRAINT "CK_requests_provider" CHECK (
    octet_length("provider") <= 84
    AND ("provider" ~ '^[a-z][a-z0-9]{1,31}$'
      OR "provider" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$')),
  ADD CONSTRAINT "CK_requests_plugin_externalId" CHECK (
    "provider" NOT LIKE '%:%' OR char_length("externalId") BETWEEN 1 AND 128);

ALTER TABLE "person_external_ids" DROP CONSTRAINT "CK_person_external_ids_provider",
  ADD CONSTRAINT "CK_person_external_ids_provider" CHECK (
    octet_length("provider") <= 84
    AND ("provider" ~ '^[a-z][a-z0-9]{1,31}$'
      OR "provider" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$')),
  ADD CONSTRAINT "CK_person_external_ids_plugin_value" CHECK (
    "provider" NOT LIKE '%:%' OR char_length("value") BETWEEN 1 AND 128);

ALTER TABLE "collection_external_ids" DROP CONSTRAINT "CK_collection_external_ids_provider",
  ADD CONSTRAINT "CK_collection_external_ids_provider" CHECK (
    octet_length("provider") <= 84
    AND ("provider" ~ '^[a-z][a-z0-9]{1,31}$'
      OR "provider" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$')),
  ADD CONSTRAINT "CK_collection_external_ids_plugin_value" CHECK (
    "provider" NOT LIKE '%:%' OR char_length("value") BETWEEN 1 AND 128);

ALTER TABLE "edition_external_ids" DROP CONSTRAINT "CK_edition_external_ids_provider",
  ADD CONSTRAINT "CK_edition_external_ids_provider" CHECK (
    octet_length("provider") <= 84
    AND ("provider" ~ '^[a-z][a-z0-9]{1,31}$'
      OR "provider" ~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$')),
  ADD CONSTRAINT "CK_edition_external_ids_plugin_value" CHECK (
    "provider" NOT LIKE '%:%' OR char_length("value") BETWEEN 1 AND 128);

-- A preferred provider may now be a plugin namespace (up to 84 bytes).
ALTER TABLE "media" ALTER COLUMN "preferredProvider" TYPE text;
ALTER TABLE "item_groups" ALTER COLUMN "preferredProvider" TYPE text;

-- A preferred provider is a namespace a provider serves: drop what the forms could not send back.
ALTER TABLE "libraries" DISABLE TRIGGER set_updated_at;
ALTER TABLE "media" DISABLE TRIGGER set_updated_at;
ALTER TABLE "item_groups" DISABLE TRIGGER set_updated_at;
UPDATE "libraries" SET "preferredProvider" = NULL
WHERE "preferredProvider" NOT IN ('tmdb', 'tvdb', 'openlibrary', 'googlebooks', 'bnf', 'audible', 'audnexus')
  AND "preferredProvider" !~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$';
UPDATE "media" SET "preferredProvider" = NULL
WHERE "preferredProvider" NOT IN ('tmdb', 'tvdb', 'openlibrary', 'googlebooks', 'bnf', 'audible', 'audnexus')
  AND "preferredProvider" !~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$';
UPDATE "item_groups" SET "preferredProvider" = NULL
WHERE "preferredProvider" NOT IN ('tmdb', 'tvdb', 'openlibrary', 'googlebooks', 'bnf', 'audible', 'audnexus')
  AND "preferredProvider" !~ '^[a-z][a-z0-9]*(\.[a-z0-9]+)*:[a-z][a-z0-9-]{0,31}$';
ALTER TABLE "item_groups" ENABLE TRIGGER set_updated_at;
ALTER TABLE "media" ENABLE TRIGGER set_updated_at;
ALTER TABLE "libraries" ENABLE TRIGGER set_updated_at;
