ALTER TABLE "refresh_tokens" ADD COLUMN "familyId" int, ADD COLUMN "parentId" int;
UPDATE "refresh_tokens" SET "familyId" = "id";
ALTER TABLE "refresh_tokens" ALTER COLUMN "familyId" SET NOT NULL;
CREATE INDEX "IDX_refresh_tokens_familyId" ON "refresh_tokens" ("familyId");
CREATE INDEX "IDX_refresh_tokens_parentId" ON "refresh_tokens" ("parentId");
