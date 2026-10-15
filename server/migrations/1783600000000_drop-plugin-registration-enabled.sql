UPDATE "plugin_packages" p SET "enabled" = false
         FROM "plugin_registrations" r
        WHERE r."pluginId" = p."pluginId" AND r."enabled" = false;

ALTER TABLE "plugin_registrations" DROP COLUMN IF EXISTS "enabled";
