-- What made each karaoke result, so an engine update marks it outdated (karaoke.md rule 12a)
ALTER TABLE "derived_audio" ADD COLUMN "revision" integer NOT NULL DEFAULT 1;
ALTER TABLE "lyrics" ADD COLUMN "alignedBy" jsonb, ADD COLUMN "pitchedBy" jsonb;

ALTER TABLE "lyrics" DISABLE TRIGGER set_updated_at;
UPDATE "lyrics" SET "alignedBy" = jsonb_strip_nulls(jsonb_build_object(
    'model', split_part("sourceRef", '#', 1),
    'version', COALESCE(substring("sourceRef" FROM '#version=([^#]*)'), ''),
    'revision', 1,
    'text', COALESCE(substring("sourceRef" FROM '#text=([^#]*)'), ''),
    'matched', COALESCE(substring("sourceRef" FROM '#matched=([0-9.]+)')::float8, 0),
    'fallback', substring("sourceRef" FROM '#fallback=(.*)$'))),
  "sourceRef" = NULL
WHERE "source" = 'generated' AND "sourceRef" IS NOT NULL;
ALTER TABLE "lyrics" ENABLE TRIGGER set_updated_at;

ALTER TABLE "karaoke_failures" ADD COLUMN "rejected" jsonb;
ALTER TABLE "karaoke_failures" DISABLE TRIGGER set_updated_at;
UPDATE "karaoke_failures" SET "rejected" = jsonb_build_object(
    'model', "rejectedBy", 'version', '', 'revision', 1, 'text', COALESCE("rejectedText", ''), 'matched', 0)
WHERE "rejectedBy" IS NOT NULL;
ALTER TABLE "karaoke_failures" ENABLE TRIGGER set_updated_at;
ALTER TABLE "karaoke_failures" DROP COLUMN "rejectedBy", DROP COLUMN "rejectedText";
