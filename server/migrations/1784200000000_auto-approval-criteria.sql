DELETE FROM "auto_approval_rules";

ALTER TABLE "auto_approval_rules" DROP COLUMN "conditions";

ALTER TABLE "auto_approval_rules" DROP COLUMN "priority";

ALTER TABLE "auto_approval_rules" ADD "criteria" jsonb NOT NULL;
