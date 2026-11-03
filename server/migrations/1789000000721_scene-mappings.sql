-- TheXEM scene to aired numbering per TVDB id; `entries` stays null until the first fetch.
CREATE TABLE "scene_mappings" (
  "tvdbId" integer PRIMARY KEY,
  "entries" jsonb,
  "fetchedAt" timestamptz
);
