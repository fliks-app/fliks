-- What queueing decided for the file (the diff's changes and warnings), shown in the job's details.
ALTER TABLE "jobs" ADD COLUMN "diff" jsonb;
