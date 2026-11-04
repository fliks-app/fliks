-- Bookmarks and highlights a user keeps on a text item (docs/spec/annotations.md).
CREATE TABLE "annotations" (
  "id" serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "itemId" integer NOT NULL REFERENCES "items" ("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "colour" text,
  "note" text NOT NULL DEFAULT '',
  "locator" jsonb NOT NULL,
  "excerpt" text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CK_annotations_kind" CHECK ("kind" IN ('bookmark', 'highlight')),
  CONSTRAINT "CK_annotations_colour" CHECK (
    ("kind" = 'bookmark' AND "colour" IS NULL)
    OR ("kind" = 'highlight' AND "colour" IN ('yellow', 'green', 'blue', 'pink'))
  ),
  CONSTRAINT "CK_annotations_locator" CHECK (jsonb_typeof("locator") = 'object')
);
CREATE INDEX "IDX_annotations_user_item" ON "annotations" ("userId", "itemId", "createdAt");
CREATE INDEX "IDX_annotations_item" ON "annotations" ("itemId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "annotations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
