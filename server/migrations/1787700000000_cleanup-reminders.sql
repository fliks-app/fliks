ALTER TABLE "cleanup_rules" ADD COLUMN "reminderDays" integer[] NOT NULL DEFAULT '{7,1}';

ALTER TABLE "cleanup_candidates" ADD COLUMN "lastReminderDays" integer;
