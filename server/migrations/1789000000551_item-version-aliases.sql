-- A version whose files a merge replaced, and the version that took its place.
CREATE TABLE "item_version_aliases" (
  "itemId" integer NOT NULL REFERENCES "items"("id") ON DELETE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 0),
  "toVersion" integer NOT NULL CHECK ("toVersion" >= 0),
  PRIMARY KEY ("itemId", "version")
);
