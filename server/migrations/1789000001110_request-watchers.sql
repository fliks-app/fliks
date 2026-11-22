-- Users following an in-flight request they did not make: they hear when it is decided or available.
CREATE TABLE "request_watchers" (
  "requestId" integer NOT NULL REFERENCES "requests" ("id") ON DELETE CASCADE,
  "userId" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_request_watchers" PRIMARY KEY ("requestId", "userId")
);
CREATE INDEX "IDX_request_watchers_user" ON "request_watchers" ("userId");
