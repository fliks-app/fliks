CREATE TABLE "watch_party_messages" (
  "partyId" integer NOT NULL REFERENCES "watch_parties" ("id") ON DELETE CASCADE,
  "id" bigint NOT NULL,
  "userId" integer REFERENCES "users" ("id") ON DELETE SET NULL,
  "username" text,
  "text" text NOT NULL,
  "system" jsonb,
  "sentAt" timestamptz NOT NULL,
  PRIMARY KEY ("partyId", "id")
);
