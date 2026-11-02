-- Addresses a user mails books to (Kindle, Kobo, PocketBook), and the log of those mailings.
CREATE TABLE "email_devices" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "address" text NOT NULL,
  "formats" text[] NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_email_devices_userId_name" UNIQUE ("userId", "name"),
  CONSTRAINT "CK_email_devices_kind" CHECK ("kind" IN ('kindle', 'kobo', 'pocketbook', 'other')),
  CONSTRAINT "CK_email_devices_formats" CHECK (cardinality("formats") > 0)
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "email_devices" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The device name is kept as sent: the row outlives the device and the file, the address is never copied.
CREATE TABLE "book_sends" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "deviceId" integer REFERENCES "email_devices"("id") ON DELETE SET NULL,
  "deviceName" text NOT NULL,
  "fileId" integer REFERENCES "media_files"("id") ON DELETE SET NULL,
  "fileName" text NOT NULL,
  "bytes" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "error" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_book_sends_status" CHECK ("status" IN ('queued', 'sending', 'sent', 'failed'))
);
CREATE INDEX "IDX_book_sends_userId_createdAt" ON "book_sends" ("userId", "createdAt");
CREATE INDEX "IDX_book_sends_deviceId" ON "book_sends" ("deviceId");
CREATE INDEX "IDX_book_sends_fileId" ON "book_sends" ("fileId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "book_sends" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
