ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "shareDisabled" boolean NOT NULL DEFAULT false;
