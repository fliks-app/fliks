-- Programmes are stored as the feed gives them and shifted per channel at read: take the old shift back out
-- (the first enabled channel of a guide id supplied it) and read every feed again, which also applies the
-- timezone correction to every stamp.
ALTER TABLE "livetv_programs" DISABLE TRIGGER set_updated_at;
ALTER TABLE "livetv_guide_sources" DISABLE TRIGGER set_updated_at;

UPDATE "livetv_programs" p
SET "startsAt" = p."startsAt" - make_interval(mins => f.shift),
    "endsAt" = p."endsAt" - make_interval(mins => f.shift)
FROM (
  SELECT guide, shift FROM (
    SELECT DISTINCT ON ("guideChannelId") "guideChannelId" AS guide, "guideShiftMinutes" AS shift
    FROM "livetv_channels" WHERE enabled AND "guideChannelId" IS NOT NULL
    ORDER BY "guideChannelId", id
  ) first WHERE shift <> 0
) f
WHERE p."guideChannelId" = f.guide;

UPDATE "livetv_guide_sources" SET etag = NULL, "lastModified" = NULL, "lastSyncAt" = NULL;

ALTER TABLE "livetv_programs" ENABLE TRIGGER set_updated_at;
ALTER TABLE "livetv_guide_sources" ENABLE TRIGGER set_updated_at;
