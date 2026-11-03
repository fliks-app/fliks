-- Each claim of a plugin namespace gets a generation; a request keeps the one it was created under,
-- so a re-claim after deleteData never matches the finished rows of the earlier claim.
CREATE SEQUENCE "provider_namespace_generation";
ALTER TABLE "provider_namespaces"
  ADD COLUMN "generation" bigint NOT NULL DEFAULT nextval('provider_namespace_generation');
ALTER TABLE "requests" ADD COLUMN "namespaceGeneration" bigint;

ALTER TABLE "requests" DISABLE TRIGGER set_updated_at;
UPDATE "requests" r SET "namespaceGeneration" = n."generation"
FROM "provider_namespaces" n WHERE n.name = r."provider";
ALTER TABLE "requests" ENABLE TRIGGER set_updated_at;
