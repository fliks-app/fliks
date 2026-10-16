CREATE TABLE "deliveries" (
  "id"            bigserial PRIMARY KEY,
  "event"         text NOT NULL,
  "targetHost"    text NOT NULL,
  "state"         text NOT NULL,
  "attempt"       integer NOT NULL DEFAULT 0,
  "lastStatus"    text NOT NULL,
  "createdAt"     timestamptz NOT NULL DEFAULT now(),
  "lastAttemptAt" timestamptz,
  "updatedAt"     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "idx_deliveries_state_id" ON "deliveries" ("state", "id");

CREATE TABLE "delivery_stats" (
  "id"                 smallint PRIMARY KEY CHECK ("id" = 1),
  "delivered"          bigint NOT NULL DEFAULT 0,
  "failedPermanently"  bigint NOT NULL DEFAULT 0,
  "droppedForCapacity" bigint NOT NULL DEFAULT 0
);
INSERT INTO "delivery_stats" ("id") VALUES (1);
