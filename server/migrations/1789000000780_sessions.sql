CREATE TABLE "sessions" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "method" text,
  "userAgent" varchar(255),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz
);
CREATE INDEX "IDX_sessions_userId" ON "sessions" ("userId");
-- The session id is the former family id, so no refresh token row is rewritten.
INSERT INTO "sessions" ("id", "userId", "userAgent", "createdAt", "lastSeenAt", "revokedAt")
SELECT "familyId", min("userId"),
       (array_agg("userAgent" ORDER BY "id" DESC) FILTER (WHERE "userAgent" IS NOT NULL))[1],
       min("createdAt"), max(COALESCE("lastUsedAt", "createdAt")),
       CASE WHEN bool_and("revokedAt" IS NOT NULL) THEN max("revokedAt") END
FROM "refresh_tokens" GROUP BY "familyId";
SELECT setval(pg_get_serial_sequence('sessions', 'id'), COALESCE((SELECT max("id") FROM "sessions"), 0) + 1, false);
ALTER TABLE "refresh_tokens" RENAME COLUMN "familyId" TO "sessionId";
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "FK_refresh_tokens_session"
  FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE;
ALTER INDEX "IDX_refresh_tokens_familyId" RENAME TO "IDX_refresh_tokens_sessionId";
