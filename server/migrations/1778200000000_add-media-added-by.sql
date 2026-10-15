ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "addedById" integer;

ALTER TABLE "media" ADD CONSTRAINT "FK_media_addedById_users"
         FOREIGN KEY ("addedById") REFERENCES "users"("id")
         ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "IDX_media_addedById" ON "media" ("addedById");

UPDATE "media" m
         SET "addedById" = sub.user_id
         FROM (
           SELECT DISTINCT ON (r."mediaId") r."mediaId", r."userId" AS user_id
           FROM "requests" r
           WHERE r."mediaId" IS NOT NULL AND r."userId" IS NOT NULL
           ORDER BY r."mediaId", r."createdAt" ASC
         ) sub
         WHERE m.id = sub."mediaId" AND m."addedById" IS NULL;
