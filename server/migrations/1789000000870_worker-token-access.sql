-- 'shared': the worker mounts the library (paths translated by pathMappings); 'none': it reads over HTTP and uploads.
ALTER TABLE "worker_tokens"
  ADD COLUMN "pathAccess" text NOT NULL DEFAULT 'none' CHECK ("pathAccess" IN ('none', 'shared')),
  ADD COLUMN "pathMappings" jsonb NOT NULL DEFAULT '[]'::jsonb;
