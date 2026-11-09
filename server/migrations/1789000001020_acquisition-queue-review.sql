-- History rows the user deleted stay as tombstones, so a provider that reports a finished transfer again does not bring them back
-- (plugins.md rule 70); `queue.manage` is the core permission for the queue actions and the history deletion (rule 73).
ALTER TABLE "acquisition_queue" ADD COLUMN "deletedAt" timestamptz;
ALTER TABLE "acquisition_queue" ADD CONSTRAINT "CK_acquisition_queue_deleted" CHECK ("deletedAt" IS NULL OR "finishedAt" IS NOT NULL);

-- The history lists skip tombstones.
DROP INDEX "IDX_acquisition_queue_history";
CREATE INDEX "IDX_acquisition_queue_history" ON "acquisition_queue" ("finishedAt" DESC, "id" DESC)
  WHERE "finishedAt" IS NOT NULL AND "deletedAt" IS NULL;

-- The roles that could manage the download plugin's queue (`queue-control`, the plugin's own grant) keep that power.
UPDATE "roles"
       SET "permissions" = ("permissions"::jsonb || '["queue.manage"]'::jsonb)::text
       WHERE ("permissions"::jsonb ? 'manage:plugin:fliks.download:queue-control'
              OR "permissions"::jsonb ? 'plugin:fliks.download:queue-control')
         AND NOT ("permissions"::jsonb ? 'queue.manage');
