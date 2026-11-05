-- A name ignoring accents, case, punctuation and word order (`Ana Placeholder`, `placeholder, ana`);
-- marks go before lower() and words split on space and punctuation, so a C-locale database keys too
CREATE FUNCTION name_key(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT string_agg(w, ' ' ORDER BY w)
  FROM regexp_split_to_table(
    replace(replace(lower(regexp_replace(normalize(t, NFD), '[\u0300-\u036f]', '', 'g')), 'œ', 'oe'), 'æ', 'ae'),
    '[[:space:][:punct:]]+') AS w
  WHERE w <> ''
$$;

CREATE INDEX "IDX_persons_name_key" ON persons (name_key(name));
