-- What a music provider says of an artist beside its name: how to file and tell it apart
ALTER TABLE "persons"
  ADD COLUMN "disambiguation" text CONSTRAINT "CK_persons_disambiguation" CHECK ("disambiguation" <> ''),
  ADD COLUMN "artistType" text CONSTRAINT "CK_persons_artistType"
    CHECK ("artistType" IN ('person', 'group', 'orchestra', 'choir', 'character', 'other'));

-- The search reads the sort name too ("Beatles, The")
CREATE OR REPLACE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.name || ' ' || COALESCE(NEW."sortName", ''));
  RETURN NEW;
END $$;
DROP TRIGGER persons_search_vector ON persons;
CREATE TRIGGER persons_search_vector BEFORE INSERT OR UPDATE OF name, "sortName"
  ON persons FOR EACH ROW EXECUTE FUNCTION persons_search_vector_update();
ALTER TABLE persons DISABLE TRIGGER set_updated_at;
UPDATE persons SET "searchVector" = to_tsvector('simple', name || ' ' || COALESCE("sortName", ''))
 WHERE "sortName" IS NOT NULL;
ALTER TABLE persons ENABLE TRIGGER set_updated_at;

-- Works are searched by title
ALTER TABLE "works" ADD COLUMN "searchVector" tsvector;
CREATE FUNCTION works_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.title);
  RETURN NEW;
END $$;
CREATE TRIGGER works_search_vector BEFORE INSERT OR UPDATE OF title
  ON works FOR EACH ROW EXECUTE FUNCTION works_search_vector_update();
CREATE INDEX "IDX_works_search_vector" ON "works" USING gin ("searchVector");
