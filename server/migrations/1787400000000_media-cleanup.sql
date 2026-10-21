CREATE TABLE "cleanup_rules" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "name" character varying NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "criteria" jsonb NOT NULL,
  "action" text NOT NULL DEFAULT 'delete' CHECK ("action" IN ('delete', 'delete_files_unmonitor', 'none')),
  "graceDays" integer CHECK ("graceDays" >= 0)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "cleanup_rules" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "cleanup_candidates" (
  "mediaId" integer PRIMARY KEY REFERENCES "media"("id") ON DELETE CASCADE,
  "ruleId" integer NOT NULL REFERENCES "cleanup_rules"("id") ON DELETE CASCADE,
  "flaggedAt" timestamptz NOT NULL DEFAULT now(),
  "deleteAt" timestamptz
);

CREATE INDEX "IDX_cleanup_candidates_ruleId" ON "cleanup_candidates" ("ruleId");

CREATE TABLE "cleanup_exclusions" (
  "mediaId" integer PRIMARY KEY REFERENCES "media"("id") ON DELETE CASCADE,
  "userId" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "IDX_cleanup_exclusions_userId" ON "cleanup_exclusions" ("userId");
