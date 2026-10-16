CREATE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', NEW.name);
  RETURN NEW;
END $$;

CREATE TRIGGER persons_search_vector BEFORE INSERT OR UPDATE OF name
  ON persons FOR EACH ROW EXECUTE FUNCTION persons_search_vector_update();

-- The backfill must not bump every "updatedAt".
ALTER TABLE persons DISABLE TRIGGER set_updated_at;
UPDATE persons SET "searchVector" = to_tsvector('simple', name);
ALTER TABLE persons ENABLE TRIGGER set_updated_at;

CREATE INDEX idx_persons_search_vector ON persons USING gin ("searchVector");
