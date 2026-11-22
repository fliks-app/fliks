-- The one folding function of every search: unaccent is not IMMUTABLE as shipped, so an index needs this wrapper.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

CREATE FUNCTION f_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT public.unaccent('public.unaccent', $1) $$;

-- Titles are unstemmed and folded (any metadata language); only the overview keeps the French stemmer.
CREATE FUNCTION media_search_vector(title text, original text, alternatives jsonb, overview text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', f_unaccent(COALESCE(title, ''))), 'A') ||
    setweight(to_tsvector('simple', f_unaccent(COALESCE(original, ''))), 'B') ||
    setweight(to_tsvector('simple', f_unaccent(COALESCE(
      CASE WHEN jsonb_typeof(alternatives) = 'array'
           THEN (SELECT string_agg(t, ' ') FROM jsonb_array_elements_text(alternatives) t) END, ''))), 'B') ||
    setweight(to_tsvector('french', f_unaccent(COALESCE(overview, ''))), 'C') $$;

CREATE OR REPLACE FUNCTION media_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := media_search_vector(NEW.title, NEW."originalTitle", NEW."alternativeTitles", NEW.overview);
  RETURN NEW;
END $$;
DROP TRIGGER media_search_vector ON media;
CREATE TRIGGER media_search_vector BEFORE INSERT OR UPDATE OF title, "originalTitle", "alternativeTitles", overview
  ON media FOR EACH ROW EXECUTE FUNCTION media_search_vector_update();

CREATE OR REPLACE FUNCTION persons_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', f_unaccent(NEW.name || ' ' || COALESCE(NEW."sortName", '')));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION works_search_vector_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', f_unaccent(NEW.title));
  RETURN NEW;
END $$;

-- Songs match this text; it is stored folded.
CREATE OR REPLACE FUNCTION track_search_text(track_item integer, track_label text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT f_unaccent(COALESCE(i.title, track_label, '') || ' ' || m.title || ' ' || COALESCE((SELECT string_agg(p.name, ' ' ORDER BY mc.position)
      FROM media_credits mc JOIN persons p ON p.id = mc."personId" WHERE mc."mediaId" = m.id AND mc.role = 'artist'), ''))
    FROM items i JOIN media m ON m.id = i."mediaId" WHERE i.id = track_item $$;

-- The backfills must not bump every "updatedAt".
ALTER TABLE media DISABLE TRIGGER set_updated_at;
UPDATE media SET "searchVector" = media_search_vector(title, "originalTitle", "alternativeTitles", overview);
ALTER TABLE media ENABLE TRIGGER set_updated_at;

ALTER TABLE persons DISABLE TRIGGER set_updated_at;
UPDATE persons SET "searchVector" = to_tsvector('simple', f_unaccent(name || ' ' || COALESCE("sortName", '')));
ALTER TABLE persons ENABLE TRIGGER set_updated_at;

UPDATE works SET "searchVector" = to_tsvector('simple', f_unaccent(title));
UPDATE track_details SET "searchText" = track_search_text("itemId", label);

-- The trigram branches of the library search compare folded titles.
DROP INDEX "IDX_media_title_trgm";
DROP INDEX "IDX_media_originalTitle_trgm";
CREATE INDEX "IDX_media_title_trgm" ON media USING gin (f_unaccent(title) gin_trgm_ops);
CREATE INDEX "IDX_media_originalTitle_trgm" ON media USING gin (f_unaccent("originalTitle") gin_trgm_ops);
