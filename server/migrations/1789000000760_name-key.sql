-- A person's or series' name with accents, case, punctuation and word order ignored:
-- `McFadden Freida`, `Freida McFadden` and `freida, mcfadden` are one key
CREATE FUNCTION name_key(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT string_agg(w, ' ' ORDER BY w)
  FROM regexp_split_to_table(
    replace(replace(regexp_replace(normalize(lower(t), NFD), '[\u0300-\u036f]', '', 'g'), 'œ', 'oe'), 'æ', 'ae'),
    '[^[:alnum:]]+') AS w
  WHERE w <> ''
$$;

CREATE INDEX "IDX_persons_name_key" ON persons (name_key(name));
