ALTER TABLE "notification_connections"
  ADD COLUMN "lastSentAt" timestamptz,
  ADD COLUMN "lastError" text,
  ADD COLUMN "lastErrorAt" timestamptz;

-- A session is live while it is not revoked and one of its refresh tokens can still be used.
CREATE FUNCTION session_is_live(p_session integer, p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM sessions s JOIN refresh_tokens t ON t."sessionId" = s.id
    WHERE s.id = p_session AND s."revokedAt" IS NULL AND t."revokedAt" IS NULL AND t."expiresAt" > p_at)
$$;
