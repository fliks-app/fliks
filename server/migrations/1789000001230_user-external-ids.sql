-- Accounts the Seerr and Emby imports created or an admin mapped: an import reuses a user only through this
-- table, never by name. `provider` is `seerr` or `emby:<server id>`.
CREATE TABLE "user_external_ids" (
  "provider" text NOT NULL,
  "externalId" text NOT NULL,
  "userId" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  CONSTRAINT "PK_user_external_ids" PRIMARY KEY ("provider", "externalId")
);
CREATE INDEX "IDX_user_external_ids_user" ON "user_external_ids" ("userId");
