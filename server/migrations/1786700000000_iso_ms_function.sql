-- JS `toISOString()` text of a timestamp, for rows serialised to JSON inside SQL.
CREATE FUNCTION iso_ms(timestamptz) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
