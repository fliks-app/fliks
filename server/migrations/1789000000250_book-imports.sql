-- The bulk import of a book library: one job row, one item per planned work (`book-import.md`).
CREATE TABLE "book_imports" (
  "id" serial PRIMARY KEY,
  "libraryId" integer NOT NULL REFERENCES "libraries"("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'running' CHECK ("status" IN ('running', 'completed', 'failed')),
  "total" integer,
  "error" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "endedOn" timestamptz
);
CREATE INDEX "IDX_book_imports_library" ON "book_imports" ("libraryId", "id");
CREATE INDEX "IDX_book_imports_user" ON "book_imports" ("userId");
CREATE UNIQUE INDEX "UQ_book_imports_running" ON "book_imports" ("libraryId") WHERE "status" = 'running';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "book_imports" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "book_import_items" (
  "id" serial PRIMARY KEY,
  "importId" integer NOT NULL REFERENCES "book_imports"("id") ON DELETE CASCADE,
  "folderId" integer NOT NULL REFERENCES "library_folders"("id") ON DELETE CASCADE,
  "groupKey" text NOT NULL,
  "folderName" text NOT NULL DEFAULT '',
  "title" text NOT NULL,
  "year" integer,
  "files" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending'
    CHECK ("status" IN ('pending', 'matched', 'manual', 'skipped', 'failed')),
  "mediaId" integer REFERENCES "media"("id") ON DELETE SET NULL,
  "error" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("importId", "folderId", "groupKey")
);
CREATE INDEX "IDX_book_import_items_status" ON "book_import_items" ("importId", "status", "id");
CREATE INDEX "IDX_book_import_items_folder" ON "book_import_items" ("folderId");
CREATE INDEX "IDX_book_import_items_media" ON "book_import_items" ("mediaId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "book_import_items" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
