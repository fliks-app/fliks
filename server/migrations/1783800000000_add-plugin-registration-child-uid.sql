ALTER TABLE "plugin_registrations" ADD COLUMN IF NOT EXISTS "childUid" integer;

ALTER TABLE "plugin_registrations"
         ADD CONSTRAINT "UQ_plugin_registrations_child_uid" UNIQUE ("childUid");
