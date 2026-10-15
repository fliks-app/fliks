ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "libraryOrder" jsonb NOT NULL DEFAULT '[]';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hiddenLibraryIds" jsonb NOT NULL DEFAULT '[]';
