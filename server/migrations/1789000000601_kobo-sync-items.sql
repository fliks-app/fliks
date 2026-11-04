-- What a Kobo device was sent, per token. refId has no foreign key: its disappearance is how a removal is detected.
CREATE TABLE "kobo_sync_items" (
  "tokenId" integer NOT NULL REFERENCES "device_tokens"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "refId" integer NOT NULL,
  "syncedAt" timestamptz NOT NULL,
  "stateAt" timestamptz NOT NULL,
  "archived" boolean NOT NULL DEFAULT false,
  "state" jsonb,
  CONSTRAINT "PK_kobo_sync_items" PRIMARY KEY ("tokenId", "kind", "refId"),
  CONSTRAINT "CK_kobo_sync_items_kind" CHECK ("kind" IN ('item', 'shelf'))
);
