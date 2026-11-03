-- A version whose files a merge replaced, and the version that took its place.
CREATE TABLE "item_version_aliases" (
  "itemId" integer NOT NULL REFERENCES "items"("id") ON DELETE CASCADE,
  "version" integer NOT NULL CHECK ("version" >= 0),
  "toVersion" integer NOT NULL CHECK ("toVersion" >= 0),
  PRIMARY KEY ("itemId", "version")
);

-- Version numbers are reused: an alias dies with the last file of the version it points to.
CREATE FUNCTION item_version_aliases_drop() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "item_version_aliases" a WHERE a."itemId" = OLD."itemId" AND a."toVersion" = OLD."version"
    AND NOT EXISTS (SELECT 1 FROM "item_parts" p WHERE p."itemId" = OLD."itemId" AND p."version" = OLD."version");
  RETURN NULL;
END $$;
CREATE TRIGGER item_version_aliases_drop AFTER DELETE ON "item_parts"
  FOR EACH ROW EXECUTE FUNCTION item_version_aliases_drop();
