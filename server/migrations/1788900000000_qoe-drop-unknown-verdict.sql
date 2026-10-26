-- Too-short playbacks are healthy, unless they logged an error.
UPDATE playback_qoe_sessions
SET "verdict" = CASE WHEN "errorCount" > 0 THEN 'error' ELSE 'ok' END,
    "confidence" = CASE WHEN "errorCount" > 0 THEN 'high' ELSE 'low' END,
    "reasons" = CASE WHEN "errorCount" > 0 THEN '["qoe.reason.fatal_error"]' ELSE '["qoe.reason.healthy"]' END::jsonb,
    "unrecoveredError" = "unrecoveredError" OR "errorCount" > 0
WHERE "verdict" = 'unknown';

UPDATE playback_qoe_sessions s
SET "playbackVerdict" = CASE WHEN EXISTS (
        SELECT 1 FROM playback_qoe_sessions o
        WHERE o."errorCount" > 0
          AND (o."sessionId" = s."sessionId" OR (o."userId" = s."userId" AND o."playbackId" = s."playbackId"))
    ) THEN 'error' ELSE 'ok' END,
    "playbackConfidence" = 'low'
WHERE "playbackVerdict" = 'unknown';

ALTER TABLE playback_qoe_sessions ALTER COLUMN "verdict" SET DEFAULT 'ok';
ALTER TABLE playback_qoe_sessions ALTER COLUMN "playbackVerdict" SET DEFAULT 'ok';
