-- The device a leased job runs on when it is not the leased one (a GPU encode redone on the CPU).
ALTER TABLE "jobs" ADD COLUMN "runsOn" text;
