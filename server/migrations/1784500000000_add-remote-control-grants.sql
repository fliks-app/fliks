CREATE TABLE IF NOT EXISTS "remote_control_grants" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "code" character varying(12),
  "deviceId" character varying NOT NULL,
  "ownerUserId" integer NOT NULL,
  "granteeUserId" integer,
  "deviceName" character varying NOT NULL,
  "codeExpiresAt" timestamptz NOT NULL
);

-- Index names match TypeORM hashes so the drift check stays quiet.
DROP INDEX IF EXISTS "IDX_remote_control_grants_code";

CREATE INDEX IF NOT EXISTS "IDX_735e31a7f8cf53db91cc04339d" ON "remote_control_grants" ("code");

DROP INDEX IF EXISTS "IDX_remote_control_grants_deviceId";

CREATE INDEX IF NOT EXISTS "IDX_34d4b3c63c41ebc088ba3cfcdb" ON "remote_control_grants" ("deviceId");

DROP INDEX IF EXISTS "IDX_remote_control_grants_ownerUserId";

CREATE INDEX IF NOT EXISTS "IDX_a5a52f3d116c44c2944f0b1088" ON "remote_control_grants" ("ownerUserId");

DROP INDEX IF EXISTS "IDX_remote_control_grants_granteeUserId";

CREATE INDEX IF NOT EXISTS "IDX_28efb3a0402a49dca862fb62e6" ON "remote_control_grants" ("granteeUserId");

ALTER TABLE "users" DROP COLUMN IF EXISTS "allowRemoteControlOfOthers";

ALTER TABLE "users" DROP COLUMN IF EXISTS "allowRemoteControlOfMyDevices";
