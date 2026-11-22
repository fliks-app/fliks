CREATE TABLE "health_checks" (
  "key" text PRIMARY KEY,
  "state" text NOT NULL CHECK ("state" IN ('warn', 'error')),
  "code" text NOT NULL,
  "params" jsonb NOT NULL DEFAULT '{}',
  "link" text,
  "since" timestamptz NOT NULL DEFAULT now(),
  "checkedAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "media_issues" ADD COLUMN "source" text NOT NULL DEFAULT 'user' CHECK ("source" IN ('user', 'health'));
ALTER TABLE "media_issues" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "media_issues" ADD CONSTRAINT "CHK_media_issues_reporter" CHECK ("source" = 'health' OR "userId" IS NOT NULL);
