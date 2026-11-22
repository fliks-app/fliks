CREATE TABLE "media_issues" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mediaId" integer NOT NULL REFERENCES "media"("id") ON DELETE CASCADE,
  "itemId" integer REFERENCES "items"("id") ON DELETE SET NULL,
  "seasonNumber" integer,
  "episodeNumber" integer,
  "mediaFileId" integer REFERENCES "media_files"("id") ON DELETE SET NULL,
  "fileSize" bigint,
  "issueKind" text NOT NULL CHECK ("issueKind" IN ('video', 'audio', 'subtitles', 'playback', 'other')),
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'acknowledged', 'resolved', 'closed')),
  "autoResolved" boolean NOT NULL DEFAULT false,
  "resolvedById" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "resolvedAt" timestamptz
);
CREATE INDEX "IDX_media_issues_media_status" ON "media_issues" ("mediaId", "status");
CREATE INDEX "IDX_media_issues_user" ON "media_issues" ("userId");
CREATE INDEX "IDX_media_issues_item" ON "media_issues" ("itemId");
CREATE INDEX "IDX_media_issues_file" ON "media_issues" ("mediaFileId");
CREATE INDEX "IDX_media_issues_resolved_by" ON "media_issues" ("resolvedById");

CREATE TABLE "media_issue_comments" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "issueId" integer NOT NULL REFERENCES "media_issues"("id") ON DELETE CASCADE,
  "userId" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "message" text NOT NULL
);
CREATE INDEX "IDX_media_issue_comments_issue" ON "media_issue_comments" ("issueId");
CREATE INDEX "IDX_media_issue_comments_user" ON "media_issue_comments" ("userId");

CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_issues" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "media_issue_comments" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
