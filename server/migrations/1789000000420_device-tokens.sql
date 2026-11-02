-- Credentials of devices that cannot log in (readers, sync apps): only a hash of the token is kept.
CREATE TYPE "device_token_kind" AS ENUM ('opds', 'kosync');

CREATE TABLE "device_tokens" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" "device_token_kind" NOT NULL,
  "hash" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastUsedAt" timestamptz
);

CREATE INDEX "IDX_device_tokens_userId" ON "device_tokens" ("userId");
