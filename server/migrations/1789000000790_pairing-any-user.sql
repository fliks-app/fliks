ALTER TABLE "pairing_requests" ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "clientIp" text, ADD COLUMN "clientNet" text;
ALTER TABLE "pairing_requests" DISABLE TRIGGER set_updated_at;
-- Codes become unique across users: the younger of a clashing pending pair expires first.
UPDATE "pairing_requests" a SET status = 'expired'
  WHERE status = 'pending' AND EXISTS (
    SELECT 1 FROM "pairing_requests" b
    WHERE b.status = 'pending' AND b.code = a.code AND b.id <> a.id
      AND (b."createdAt", b.id) < (a."createdAt", a.id));
ALTER TABLE "pairing_requests" ENABLE TRIGGER set_updated_at;
DROP INDEX "UQ_pairing_requests_pending_code";
CREATE UNIQUE INDEX "UQ_pairing_requests_pending_code" ON "pairing_requests" ("code") WHERE status = 'pending';
CREATE INDEX "IDX_pairing_requests_clientNet" ON "pairing_requests" ("clientNet") WHERE status = 'pending';
