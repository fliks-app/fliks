CREATE TABLE "book_merges" (
  "mediaId" integer PRIMARY KEY REFERENCES "media"("id") ON DELETE CASCADE,
  "fingerprint" text NOT NULL,
  "state" text NOT NULL,
  "folderId" integer NOT NULL,
  "output" text NOT NULL,
  "error" text,
  "jobId" text,
  "attempts" integer NOT NULL DEFAULT 0,
  "jobFailures" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_book_merges_state" CHECK ("state" IN ('running', 'failed', 'retry'))
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "book_merges" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
