CREATE TABLE "worker_tokens" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE,
  "enabled" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastSeenAt" timestamptz,
  "revokedAt" timestamptz
);

-- A moved or deleted file can no longer be optimised: its pending job ends here, whichever code path moved it.
CREATE FUNCTION "cancel_jobs_of_media_file"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "jobs"
     SET "state" = 'cancelled',
         "error" = '{"class":"cancelled","message":"media file moved or deleted"}'::jsonb,
         "finishedAt" = now(), "updatedAt" = now()
   WHERE "mediaFileId" = OLD."id" AND "state" IN ('queued', 'leased', 'staged');
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER "media_files_cancel_jobs_delete" BEFORE DELETE ON "media_files"
  FOR EACH ROW EXECUTE FUNCTION "cancel_jobs_of_media_file"();

CREATE TRIGGER "media_files_cancel_jobs_move"
  BEFORE UPDATE OF "folderId", "relativePath" ON "media_files"
  FOR EACH ROW WHEN (OLD."folderId" IS DISTINCT FROM NEW."folderId"
                  OR OLD."relativePath" IS DISTINCT FROM NEW."relativePath")
  EXECUTE FUNCTION "cancel_jobs_of_media_file"();
