CREATE TABLE "user_quotas" (
  "userId" integer NOT NULL,
  "kind" text NOT NULL,
  "limit" integer NOT NULL,
  CONSTRAINT "PK_user_quotas" PRIMARY KEY ("userId", "kind"),
  CONSTRAINT "FK_user_quotas_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "CK_user_quotas_kind" CHECK ("kind" IN ('movie', 'series')),
  CONSTRAINT "CK_user_quotas_limit" CHECK ("limit" <> 0)
);

INSERT INTO "user_quotas" ("userId", "kind", "limit")
SELECT "id", 'movie', "movieQuotaLimit" FROM "users" WHERE "movieQuotaLimit" <> 0
UNION ALL
SELECT "id", 'series', "seriesQuotaLimit" FROM "users" WHERE "seriesQuotaLimit" <> 0;

ALTER TABLE "users" DROP COLUMN "movieQuotaLimit", DROP COLUMN "seriesQuotaLimit";
