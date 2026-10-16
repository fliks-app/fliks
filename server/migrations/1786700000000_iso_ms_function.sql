-- JS `toISOString()` text of a timestamp, for rows serialised to JSON inside SQL.
-- A `timestamp` column holds UTC wall time (as sqlx decodes it), whatever the session TimeZone.
CREATE FUNCTION iso_ms(timestamp) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT to_char($1, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

CREATE FUNCTION iso_ms(timestamptz) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT to_char($1 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
