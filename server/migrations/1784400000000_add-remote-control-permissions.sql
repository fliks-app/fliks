ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "allowRemoteControlOfOthers" boolean NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "allowRemoteControlOfMyDevices" boolean NOT NULL DEFAULT false;
