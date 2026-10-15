ALTER TABLE "livetv_channels" ADD COLUMN IF NOT EXISTS "groupNameSource" character varying(16) NOT NULL DEFAULT 'provider';

UPDATE "livetv_channels"
   SET "groupName" = CASE
     WHEN "groupName" IS NULL OR btrim("groupName") = '' THEN '__livetv_ungrouped__'
     ELSE btrim("groupName")
   END
 WHERE "groupName" IS NULL OR "groupName" != btrim("groupName") OR btrim("groupName") = '';

CREATE INDEX IF NOT EXISTS "IDX_livetv_channels_group_norm" ON "livetv_channels" (lower(btrim("groupName")));

DELETE FROM "livetv_group_access" a
 USING "livetv_group_access" b
 WHERE a.id > b.id
   AND a."userId" = b."userId"
   AND btrim(a."groupName") = btrim(b."groupName");

UPDATE "livetv_group_access" SET "groupName" = btrim("groupName") WHERE "groupName" != btrim("groupName");

CREATE OR REPLACE FUNCTION pg_temp._js_is_trim_codepoint(cp int) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cp IN (
    9, 10, 11, 12, 13, 32, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279
  );
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_trim(s text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  l int := 1;
  r int;
  cp int;
BEGIN
  IF s IS NULL THEN
    RETURN NULL;
  END IF;
  r := length(s);
  WHILE l <= r LOOP
    cp := ascii(substring(s FROM l FOR 1));
    EXIT WHEN NOT pg_temp._js_is_trim_codepoint(cp);
    l := l + 1;
  END LOOP;
  WHILE r >= l LOOP
    cp := ascii(substring(s FROM r FOR 1));
    EXIT WHEN NOT pg_temp._js_is_trim_codepoint(cp);
    r := r - 1;
  END LOOP;
  RETURN substring(s FROM l FOR r - l + 1);
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_utf16_units(s text) RETURNS int[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  units int[] := '{}';
  i int;
  cp int;
BEGIN
  IF s IS NULL THEN
    RETURN '{}';
  END IF;
  FOR i IN 1..length(s) LOOP
    cp := ascii(substring(s FROM i FOR 1));
    IF cp > 65535 THEN
      units := units || (((cp - 65536) >> 10) + 55296)::int;
      units := units || (((cp - 65536) & 1023) + 56320)::int;
    ELSE
      units := units || cp;
    END IF;
  END LOOP;
  RETURN units;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_utf16_compare(a text, b text) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ua int[] := pg_temp.js_utf16_units(a);
  ub int[] := pg_temp.js_utf16_units(b);
  la int := coalesce(array_length(ua, 1), 0);
  lb int := coalesce(array_length(ub, 1), 0);
  n int := least(la, lb);
  i int;
BEGIN
  FOR i IN 1..n LOOP
    IF ua[i] < ub[i] THEN RETURN -1; END IF;
    IF ua[i] > ub[i] THEN RETURN 1; END IF;
  END LOOP;
  IF la < lb THEN RETURN -1; END IF;
  IF la > lb THEN RETURN 1; END IF;
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_json_string(s text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out text := '"';
  i int;
  c text;
  cp int;
  hex text;
BEGIN
  IF s IS NULL THEN
    RETURN 'null';
  END IF;
  FOR i IN 1..length(s) LOOP
    c := substring(s FROM i FOR 1);
    cp := ascii(c);
    IF c = '"' THEN
      out := out || E'\\"';
    ELSIF c = E'\\' THEN
      out := out || E'\\\\';
    ELSIF cp = 8 THEN
      out := out || E'\\b';
    ELSIF cp = 9 THEN
      out := out || E'\\t';
    ELSIF cp = 10 THEN
      out := out || E'\\n';
    ELSIF cp = 12 THEN
      out := out || E'\\f';
    ELSIF cp = 13 THEN
      out := out || E'\\r';
    ELSIF cp < 32 THEN
      hex := lpad(to_hex(cp), 4, '0');
      out := out || '\u' || hex;
    ELSE
      out := out || c;
    END IF;
  END LOOP;
  RETURN out || '"';
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_json_string_array(items text[]) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  parts text[] := '{}';
  i int;
BEGIN
  IF items IS NULL OR coalesce(array_length(items, 1), 0) = 0 THEN
    RETURN '[]';
  END IF;
  FOR i IN 1..array_length(items, 1) LOOP
    parts := array_append(parts, pg_temp.js_json_string(items[i]));
  END LOOP;
  RETURN '[' || array_to_string(parts, ',') || ']';
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_finite_date_ms(s text) RETURNS double precision
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  ms double precision;
BEGIN
  IF s IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    ms := (EXTRACT(EPOCH FROM s::timestamptz) * 1000)::double precision;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN NULL;
  END;
  IF ms IS NULL OR ms <> ms OR ms IN ('Infinity'::double precision, '-Infinity'::double precision) THEN
    RETURN NULL;
  END IF;
  RETURN ms;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp._json_skip_ws(raw text, p int) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cp int;
BEGIN
  WHILE p <= length(raw) LOOP
    cp := ascii(substring(raw FROM p FOR 1));
    EXIT WHEN NOT pg_temp._js_is_trim_codepoint(cp);
    p := p + 1;
  END LOOP;
  RETURN p;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp._json_parse_string(raw text, p int, OUT np int, OUT decoded text)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  i int;
  c text;
  esc text;
  hex text;
  cp int;
BEGIN
  IF substring(raw FROM p FOR 1) <> '"' THEN
    RAISE EXCEPTION 'expected json string';
  END IF;
  decoded := '';
  i := p + 1;
  WHILE i <= length(raw) LOOP
    c := substring(raw FROM i FOR 1);
    IF c = '"' THEN
      np := i + 1;
      RETURN;
    ELSIF c = E'\\' THEN
      i := i + 1;
      IF i > length(raw) THEN
        RAISE EXCEPTION 'bad json escape';
      END IF;
      esc := substring(raw FROM i FOR 1);
      IF esc = '"' THEN decoded := decoded || '"';
      ELSIF esc = E'\\' THEN decoded := decoded || E'\\';
      ELSIF esc = '/' THEN decoded := decoded || '/';
      ELSIF esc = 'b' THEN decoded := decoded || chr(8);
      ELSIF esc = 'f' THEN decoded := decoded || chr(12);
      ELSIF esc = 'n' THEN decoded := decoded || chr(10);
      ELSIF esc = 'r' THEN decoded := decoded || chr(13);
      ELSIF esc = 't' THEN decoded := decoded || chr(9);
      ELSIF esc = 'u' THEN
        hex := substring(raw FROM i + 1 FOR 4);
        IF hex !~ '^[0-9a-fA-F]{4}$' THEN
          RAISE EXCEPTION 'bad json unicode escape';
        END IF;
        cp := get_byte(decode(hex, 'hex'), 0) * 256 + get_byte(decode(hex, 'hex'), 1);
        decoded := decoded || chr(cp);
        i := i + 4;
      ELSE
        RAISE EXCEPTION 'bad json escape';
      END IF;
    ELSE
      decoded := decoded || c;
    END IF;
    i := i + 1;
  END LOOP;
  RAISE EXCEPTION 'unterminated json string';
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp._json_skip_value(raw text, p int) RETURNS int
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  c text;
  dummy text;
BEGIN
  p := pg_temp._json_skip_ws(raw, p);
  IF p > length(raw) THEN
    RAISE EXCEPTION 'unexpected end of json';
  END IF;
  c := substring(raw FROM p FOR 1);
  IF c = '"' THEN
    SELECT f.np INTO p FROM pg_temp._json_parse_string(raw, p) f;
    RETURN p;
  ELSIF c = '{' THEN
    p := p + 1;
    p := pg_temp._json_skip_ws(raw, p);
    IF substring(raw FROM p FOR 1) = '}' THEN
      RETURN p + 1;
    END IF;
    LOOP
      SELECT f.np INTO p FROM pg_temp._json_parse_string(raw, p) f;
      p := pg_temp._json_skip_ws(raw, p);
      IF substring(raw FROM p FOR 1) <> ':' THEN
        RAISE EXCEPTION 'expected colon in json object';
      END IF;
      p := pg_temp._json_skip_value(raw, p + 1);
      p := pg_temp._json_skip_ws(raw, p);
      c := substring(raw FROM p FOR 1);
      IF c = '}' THEN
        RETURN p + 1;
      ELSIF c = ',' THEN
        p := p + 1;
      ELSE
        RAISE EXCEPTION 'expected comma or closing brace';
      END IF;
    END LOOP;
  ELSIF c = '[' THEN
    p := p + 1;
    p := pg_temp._json_skip_ws(raw, p);
    IF substring(raw FROM p FOR 1) = ']' THEN
      RETURN p + 1;
    END IF;
    LOOP
      p := pg_temp._json_skip_value(raw, p);
      p := pg_temp._json_skip_ws(raw, p);
      c := substring(raw FROM p FOR 1);
      IF c = ']' THEN
        RETURN p + 1;
      ELSIF c = ',' THEN
        p := p + 1;
      ELSE
        RAISE EXCEPTION 'expected comma or closing bracket';
      END IF;
    END LOOP;
  ELSIF c = 't' THEN
    IF substring(raw FROM p FOR 4) <> 'true' THEN RAISE EXCEPTION 'bad json literal'; END IF;
    RETURN p + 4;
  ELSIF c = 'f' THEN
    IF substring(raw FROM p FOR 5) <> 'false' THEN RAISE EXCEPTION 'bad json literal'; END IF;
    RETURN p + 5;
  ELSIF c = 'n' THEN
    IF substring(raw FROM p FOR 4) <> 'null' THEN RAISE EXCEPTION 'bad json literal'; END IF;
    RETURN p + 4;
  ELSIF c ~ '[-0-9]' THEN
    WHILE p <= length(raw) AND substring(raw FROM p FOR 1) ~ '[0-9.eE+-]' LOOP
      p := p + 1;
    END LOOP;
    RETURN p;
  ELSE
    RAISE EXCEPTION 'bad json value';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.js_parse_object_raw(
  raw text,
  OUT keys_first text[],
  OUT string_values jsonb,
  OUT last_is_string jsonb
)
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  p int;
  c text;
  raw_key text;
  val_p int;
  val_decoded text;
  is_string boolean;
BEGIN
  keys_first := '{}';
  string_values := '{}'::jsonb;
  last_is_string := '{}'::jsonb;
  p := pg_temp._json_skip_ws(raw, 1);
  IF substring(raw FROM p FOR 1) <> '{' THEN
    RAISE EXCEPTION 'expected json object';
  END IF;
  p := p + 1;
  p := pg_temp._json_skip_ws(raw, p);
  IF substring(raw FROM p FOR 1) = '}' THEN
    RETURN;
  END IF;
  LOOP
    SELECT f.np, f.decoded INTO val_p, raw_key FROM pg_temp._json_parse_string(raw, p) f;
    p := val_p;
    p := pg_temp._json_skip_ws(raw, p);
    IF substring(raw FROM p FOR 1) <> ':' THEN
      RAISE EXCEPTION 'expected colon';
    END IF;
    p := p + 1;
    p := pg_temp._json_skip_ws(raw, p);
    is_string := substring(raw FROM p FOR 1) = '"';
    IF NOT (raw_key = ANY(keys_first)) THEN
      keys_first := array_append(keys_first, raw_key);
    END IF;
    IF is_string THEN
      SELECT f.np, f.decoded INTO val_p, val_decoded FROM pg_temp._json_parse_string(raw, p) f;
      p := val_p;
      last_is_string := last_is_string || jsonb_build_object(raw_key, true);
      string_values := string_values || jsonb_build_object(raw_key, val_decoded);
    ELSE
      p := pg_temp._json_skip_value(raw, p);
      last_is_string := last_is_string || jsonb_build_object(raw_key, false);
      string_values := string_values - raw_key;
    END IF;
    p := pg_temp._json_skip_ws(raw, p);
    c := substring(raw FROM p FOR 1);
    IF c = '}' THEN
      RETURN;
    ELSIF c = ',' THEN
      p := p + 1;
    ELSE
      RAISE EXCEPTION 'expected comma or closing brace';
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  setting_key text;
  raw text;
  parsed json;
  items text[] := '{}';
  seen text[] := '{}';
  normalized text;
  elem json;
  t text;
  i int;
  j int;
  tmp text;
  keys_first text[];
  string_values jsonb;
  last_is_string jsonb;
  raw_name text;
  since text;
  trimmed_key text;
  existing_since text;
  since_ms double precision;
  existing_ms double precision;
  trimmed_keys text[] := '{}';
  trimmed_vals text[] := '{}';
  out_parts text[] := '{}';
  out_json text;
  idx int;
BEGIN
  FOREACH setting_key IN ARRAY ARRAY['livetv_restricted_groups', 'livetv_restricted_groups_exempt']
  LOOP
    SELECT value INTO raw FROM "app_settings" WHERE key = setting_key;
    IF raw IS NULL OR raw = '' THEN
      CONTINUE;
    END IF;
    BEGIN
      parsed := raw::json;
    EXCEPTION
      WHEN OTHERS THEN
        CONTINUE;
    END;
    IF json_typeof(parsed) <> 'array' THEN
      CONTINUE;
    END IF;
    items := '{}';
    seen := '{}';
    FOR elem IN SELECT value FROM json_array_elements(parsed)
    LOOP
      IF json_typeof(elem) <> 'string' THEN
        CONTINUE;
      END IF;
      t := pg_temp.js_trim(elem #>> '{}');
      IF t = '' OR t = ANY(seen) THEN
        CONTINUE;
      END IF;
      seen := array_append(seen, t);
      items := array_append(items, t);
    END LOOP;
    IF coalesce(array_length(items, 1), 0) > 1 THEN
      FOR i IN 1..array_length(items, 1) - 1 LOOP
        FOR j IN i + 1..array_length(items, 1) LOOP
          IF pg_temp.js_utf16_compare(items[i], items[j]) > 0 THEN
            tmp := items[i];
            items[i] := items[j];
            items[j] := tmp;
          END IF;
        END LOOP;
      END LOOP;
    END IF;
    normalized := pg_temp.js_json_string_array(items);
    UPDATE "app_settings" SET value = normalized WHERE key = setting_key;
  END LOOP;

  SELECT value INTO raw FROM "app_settings" WHERE key = 'livetv_restricted_groups_vanished';
  IF raw IS NULL OR raw = '' THEN
    RETURN;
  END IF;
  BEGIN
    SELECT p.keys_first, p.string_values, p.last_is_string
      INTO keys_first, string_values, last_is_string
      FROM pg_temp.js_parse_object_raw(raw) AS p;
  EXCEPTION
    WHEN OTHERS THEN
      RETURN;
  END;

  trimmed_keys := '{}';
  trimmed_vals := '{}';
  FOREACH raw_name IN ARRAY keys_first
  LOOP
    IF coalesce((last_is_string ->> raw_name)::boolean, false) IS NOT TRUE THEN
      CONTINUE;
    END IF;
    since := string_values ->> raw_name;
    IF since IS NULL THEN
      CONTINUE;
    END IF;
    trimmed_key := pg_temp.js_trim(raw_name);
    IF trimmed_key = '' THEN
      CONTINUE;
    END IF;
    idx := array_position(trimmed_keys, trimmed_key);
    IF idx IS NULL THEN
      trimmed_keys := array_append(trimmed_keys, trimmed_key);
      trimmed_vals := array_append(trimmed_vals, since);
    ELSE
      since_ms := pg_temp.js_finite_date_ms(since);
      existing_since := trimmed_vals[idx];
      existing_ms := pg_temp.js_finite_date_ms(existing_since);
      IF since_ms IS NOT NULL AND existing_ms IS NOT NULL AND since_ms < existing_ms THEN
        trimmed_vals[idx] := since;
      END IF;
    END IF;
  END LOOP;

  IF coalesce(array_length(trimmed_keys, 1), 0) = 0 THEN
    out_json := '{}';
  ELSE
    FOR i IN 1..array_length(trimmed_keys, 1) LOOP
      out_parts := array_append(
        out_parts,
        pg_temp.js_json_string(trimmed_keys[i]) || ':' || pg_temp.js_json_string(trimmed_vals[i])
      );
    END LOOP;
    out_json := '{' || array_to_string(out_parts, ',') || '}';
  END IF;

  UPDATE "app_settings" SET value = out_json WHERE key = 'livetv_restricted_groups_vanished';
END $$;
