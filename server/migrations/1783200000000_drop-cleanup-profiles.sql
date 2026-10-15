ALTER TABLE "libraries" DROP COLUMN "stalledCleanupProfile";

DROP TABLE "cleanup_profiles";

UPDATE "app_settings" SET "key" = 'plugin.download.stall_include_manual_grabs' WHERE "key" = 'cleanup_restart_manual_grabs';
