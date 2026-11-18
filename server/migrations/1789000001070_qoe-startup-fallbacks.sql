ALTER TABLE "playback_qoe_sessions"
  ADD COLUMN "startupMs" integer,
  ADD COLUMN "startupCause" character varying,
  ADD COLUMN "fallbackReloads" integer NOT NULL DEFAULT 0;

UPDATE "playback_qoe_sessions" s SET "fallbackReloads" = e.n
FROM (
  SELECT "sessionId", count(*)::int AS n FROM "playback_qoe_events"
  WHERE "type" = 'reload' AND "data"->>'reason' LIKE '%\_fallback'
  GROUP BY "sessionId"
) e
WHERE s."sessionId" = e."sessionId";
