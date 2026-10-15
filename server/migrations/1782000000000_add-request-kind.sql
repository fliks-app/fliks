
      DO $$ BEGIN
        CREATE TYPE "public"."requests_kind_enum" AS ENUM('add', 'delete');
      EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "requests" ADD COLUMN IF NOT EXISTS "kind" "public"."requests_kind_enum" NOT NULL DEFAULT 'add';
