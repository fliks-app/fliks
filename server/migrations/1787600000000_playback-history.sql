CREATE TABLE "playback_history" (
  "id" SERIAL PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "episodeId" integer REFERENCES "episodes"("id") ON DELETE CASCADE,
  "playedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "IDX_playback_history_mediaId_playedAt" ON "playback_history" ("mediaId", "playedAt");
CREATE INDEX "IDX_playback_history_userId" ON "playback_history" ("userId");
CREATE INDEX "IDX_playback_history_episodeId" ON "playback_history" ("episodeId");

INSERT INTO "playback_history" ("userId", "mediaId", "episodeId", "playedAt")
SELECT "userId", "mediaId", "episodeId", COALESCE("playedAt", "lastPlayedAt", "updatedAt")
FROM "playback_states" WHERE "completed" AND "userId" IS NOT NULL AND "mediaId" IS NOT NULL;
