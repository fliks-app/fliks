CREATE TABLE "media_file_hashes" (
  "mediaFileId" integer NOT NULL,
  "kind" text NOT NULL,
  "hash" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_media_file_hashes" PRIMARY KEY ("mediaFileId", "kind"),
  CONSTRAINT "FK_media_file_hashes_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE,
  CONSTRAINT "CK_media_file_hashes_kind" CHECK ("kind" IN ('koreader')),
  CONSTRAINT "CK_media_file_hashes_hash" CHECK ("hash" ~ '^[0-9a-f]{32}$')
);
CREATE INDEX "IDX_media_file_hashes_lookup" ON "media_file_hashes" ("kind", "hash");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_file_hashes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
