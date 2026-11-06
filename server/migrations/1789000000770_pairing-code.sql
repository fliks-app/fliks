-- Requests opened before codes existed can't be approved any more.
DELETE FROM "pairing_requests";
ALTER TABLE "pairing_requests" ADD COLUMN "code" varchar(6) NOT NULL;
CREATE UNIQUE INDEX "UQ_pairing_requests_pending_code" ON "pairing_requests" ("userId", "code")
  WHERE status = 'pending';
