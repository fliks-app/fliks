CREATE FUNCTION media_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('french', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('french', COALESCE(NEW."originalTitle", '')), 'B') ||
    setweight(to_tsvector('french', COALESCE(NEW.overview, '')), 'C');
  RETURN NEW;
END $$;

CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", overview
  ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update();

-- The backfill must not bump every "updatedAt".
ALTER TABLE media DISABLE TRIGGER set_updated_at;
UPDATE media SET "searchVector" =
  setweight(to_tsvector('french', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('french', COALESCE("originalTitle", '')), 'B') ||
  setweight(to_tsvector('french', COALESCE(overview, '')), 'C');
ALTER TABLE media ENABLE TRIGGER set_updated_at;

CREATE INDEX idx_media_search_vector ON media USING gin ("searchVector");
