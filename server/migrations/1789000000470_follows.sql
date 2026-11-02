CREATE TABLE "person_follows" (
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "personId" integer NOT NULL REFERENCES "persons"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "newReleases" boolean NOT NULL DEFAULT true,
  "libraryId" integer NOT NULL REFERENCES "libraries"("id") ON DELETE CASCADE,
  "wants" jsonb NOT NULL,
  "since" date NOT NULL DEFAULT CURRENT_DATE,
  "refreshedAt" timestamptz,
  "failedAdds" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_person_follows" PRIMARY KEY ("userId", "personId", "role"),
  CONSTRAINT "CK_person_follows_role" CHECK ("role" IN ('author'))
);
CREATE INDEX "IDX_person_follows_personId" ON "person_follows" ("personId");
CREATE INDEX "IDX_person_follows_libraryId" ON "person_follows" ("libraryId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "person_follows" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "series_watches" (
  "userId" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "collectionId" integer NOT NULL REFERENCES "collections"("id") ON DELETE CASCADE,
  "libraryId" integer NOT NULL REFERENCES "libraries"("id") ON DELETE CASCADE,
  "wants" jsonb NOT NULL,
  "since" date NOT NULL DEFAULT CURRENT_DATE,
  "refreshedAt" timestamptz,
  "failedAdds" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_series_watches" PRIMARY KEY ("userId", "collectionId")
);
CREATE INDEX "IDX_series_watches_collectionId" ON "series_watches" ("collectionId");
CREATE INDEX "IDX_series_watches_libraryId" ON "series_watches" ("libraryId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "series_watches" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE "discovered_works" (
  "provider" text NOT NULL,
  "value" text NOT NULL,
  "mediaId" integer REFERENCES "media"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_discovered_works" PRIMARY KEY ("provider", "value")
);
CREATE INDEX "IDX_discovered_works_mediaId" ON "discovered_works" ("mediaId");
