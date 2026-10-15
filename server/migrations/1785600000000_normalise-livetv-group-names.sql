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

DO $$
DECLARE
  k text;
  v jsonb;
  -- JS String.prototype.trim(): WhiteSpace and LineTerminator, not just spaces.
  c constant text := '[\t-\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]';
  ws constant text := '^' || c || '+|' || c || '+$';
BEGIN
  FOREACH k IN ARRAY ARRAY['livetv_restricted_groups', 'livetv_restricted_groups_exempt', 'livetv_restricted_groups_vanished'] LOOP
    BEGIN
      v := (SELECT value FROM "app_settings" WHERE key = k)::jsonb;
    EXCEPTION WHEN others THEN
      CONTINUE;
    END;

    -- Sorted by code point, as JS's default sort is for BMP text.
    IF k = 'livetv_restricted_groups_vanished' THEN
      IF jsonb_typeof(v) = 'object' THEN
        -- ISO timestamps: the lexicographic min is the earliest date.
        UPDATE "app_settings" SET value = COALESCE((
          SELECT jsonb_object_agg(g, since)::text FROM (
            SELECT regexp_replace(e.key, ws, '', 'g') AS g, min(e.value #>> '{}') AS since
              FROM jsonb_each(v) e
             WHERE jsonb_typeof(e.value) = 'string'
             GROUP BY 1) m WHERE g <> ''), '{}') WHERE key = k;
      END IF;
    ELSIF jsonb_typeof(v) = 'array' THEN
      UPDATE "app_settings" SET value = COALESCE((
        SELECT jsonb_agg(g ORDER BY g COLLATE "C")::text FROM (
          SELECT DISTINCT regexp_replace(e #>> '{}', ws, '', 'g') AS g
            FROM jsonb_array_elements(v) e
           WHERE jsonb_typeof(e) = 'string') m WHERE g <> ''), '[]') WHERE key = k;
    END IF;
  END LOOP;
END $$;
