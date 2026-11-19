-- The built-in Fliks Relay connection: seeded disabled, the only one of its type.
INSERT INTO "notification_connections" ("name", "type", "settings", "events", "enabled")
VALUES ('Fliks Relay', 'fliks-relay', '{}', '[]', false);
CREATE UNIQUE INDEX "UQ_notification_connections_fliks_relay"
  ON "notification_connections" ("type") WHERE "type" = 'fliks-relay';

-- One push endpoint per session and platform: a mobile one (`sub` is its id at the relay) or a browser one.
CREATE TABLE "push_subscriptions" (
  "id" SERIAL NOT NULL,
  "sessionId" integer NOT NULL REFERENCES "sessions" ("id") ON DELETE CASCADE,
  "platform" text NOT NULL CHECK ("platform" IN ('apns', 'fcm', 'web')),
  "sub" text UNIQUE,
  "endpoint" text,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "locale" text NOT NULL DEFAULT 'en',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_push_subscriptions" PRIMARY KEY ("id"),
  CONSTRAINT "UQ_push_subscriptions_session_platform" UNIQUE ("sessionId", "platform"),
  CONSTRAINT "CHK_push_subscriptions_kind" CHECK (("platform" = 'web') = ("endpoint" IS NOT NULL AND "sub" IS NULL))
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "push_subscriptions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Categories this user does not want, any device.
ALTER TABLE "users" ADD COLUMN "pushMuted" text[] NOT NULL DEFAULT '{}';
