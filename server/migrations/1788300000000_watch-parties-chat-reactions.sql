ALTER TABLE "watch_parties" ADD COLUMN IF NOT EXISTS "reactionsEnabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "watch_parties" ADD COLUMN IF NOT EXISTS "chatEnabled" boolean NOT NULL DEFAULT true;
