-- The app and version a session was last seen from (`X-Fliks-Client`), next to its user agent.
ALTER TABLE "sessions" ADD COLUMN "client" text;
