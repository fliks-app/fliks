-- A scheme-less url never connected (the request builder rejects it): give it the form's http:// default.
UPDATE media_servers SET url = 'http://' || btrim(url)
WHERE btrim(url) <> '' AND btrim(url) !~* '^[a-z][a-z0-9+.-]*://';

-- Keep only the events the row's type supports (emby's seven; no other type has a provider).
WITH cleaned AS (
  SELECT m.id, COALESCE((
    SELECT jsonb_agg(e.v ORDER BY e.i)
    FROM jsonb_array_elements(m.events) WITH ORDINALITY AS e(v, i)
    WHERE m.type = 'emby' AND e.v IN (
      '"download.complete"', '"subtitle.downloaded"', '"subtitle.upgraded"', '"subtitle.synced"',
      '"file.deleted"', '"media.deleted"', '"library.rescan"')
  ), '[]'::jsonb) AS events
  FROM media_servers m
)
UPDATE media_servers m SET events = c.events FROM cleaned c WHERE c.id = m.id AND c.events <> m.events;
