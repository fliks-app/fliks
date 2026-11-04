-- The file a reader opens for an issue (items.md rule 35): the state's file when it is still a part,
-- else the first part of the state's version, else of the highest version. The detail payload and
-- the page routes both call it, so the file a client is told about is the file the routes serve.
CREATE FUNCTION comic_part(item integer, uid integer) RETURNS integer LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT ip."mediaFileId" FROM item_parts ip
    LEFT JOIN playback_states ps ON ps."itemId" = ip."itemId" AND ps."userId" = uid
   WHERE ip."itemId" = item
   ORDER BY (ip."mediaFileId" = ps."mediaFileId") DESC NULLS LAST, (ip.version = ps.version) DESC NULLS LAST,
            ip.version DESC, ip.position, ip."mediaFileId"
   LIMIT 1
$$;
