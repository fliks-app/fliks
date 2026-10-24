CREATE TABLE IF NOT EXISTS "watch_parties" (
  "id" SERIAL PRIMARY KEY,
  "name" text NOT NULL,
  "ownerId" int NOT NULL,
  "mediaId" int NOT NULL,
  "mediaFileId" int,
  "episodeId" int,
  "inviteToken" text NOT NULL,
  "policy" text NOT NULL DEFAULT 'everyone',
  "scheduledAt" timestamptz,
  "status" text NOT NULL,
  "position" double precision NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "startedAt" timestamptz,
  "endedAt" timestamptz,
  CONSTRAINT "UQ_watch_parties_invite_token" UNIQUE ("inviteToken"),
  CONSTRAINT "CHK_watch_parties_policy" CHECK ("policy" IN ('everyone', 'host_only')),
  CONSTRAINT "CHK_watch_parties_status" CHECK ("status" IN ('scheduled', 'live', 'ended')),
  CONSTRAINT "CHK_watch_parties_name" CHECK (char_length("name") BETWEEN 1 AND 80),
  CONSTRAINT "FK_watch_parties_owner" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_watch_parties_media" FOREIGN KEY ("mediaId") REFERENCES "media"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "IDX_watch_parties_status" ON "watch_parties" ("status");

CREATE INDEX IF NOT EXISTS "IDX_watch_parties_owner" ON "watch_parties" ("ownerId");

CREATE TABLE IF NOT EXISTS "watch_party_invitees" (
  "partyId" int NOT NULL,
  "userId" int NOT NULL,
  CONSTRAINT "PK_watch_party_invitees" PRIMARY KEY ("partyId", "userId"),
  CONSTRAINT "FK_watch_party_invitees_party" FOREIGN KEY ("partyId") REFERENCES "watch_parties"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_watch_party_invitees_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "IDX_watch_party_invitees_user" ON "watch_party_invitees" ("userId");
