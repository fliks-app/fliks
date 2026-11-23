-- A series' monitoring is derived from its seasons; "monitorNewSeasons" is the flag a new season gets.
ALTER TABLE "media" ADD COLUMN "monitorNewSeasons" boolean NOT NULL DEFAULT true;

ALTER TABLE "media" DISABLE TRIGGER set_updated_at;
ALTER TABLE "item_groups" DISABLE TRIGGER set_updated_at;
UPDATE "media" SET "monitorNewSeasons" = monitored WHERE "type" = 'series';
-- An unmonitored series must not start downloading once its seasons decide.
UPDATE "item_groups" SET monitored = false
 WHERE monitored AND "mediaId" IN (SELECT id FROM "media" WHERE "type" = 'series' AND NOT monitored);

-- 'none' | 'partial' | 'all'; season 0 only tells none from partial.
CREATE FUNCTION series_monitoring(media_id integer, policy boolean) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM item_groups WHERE "mediaId" = media_id AND "number" > 0) THEN
      CASE WHEN EXISTS (SELECT 1 FROM item_groups WHERE "mediaId" = media_id AND "number" = 0 AND monitored) THEN 'partial'
           WHEN policy THEN 'all' ELSE 'none' END
    WHEN NOT EXISTS (SELECT 1 FROM item_groups WHERE "mediaId" = media_id AND monitored) THEN 'none'
    WHEN NOT EXISTS (SELECT 1 FROM item_groups WHERE "mediaId" = media_id AND "number" > 0 AND NOT monitored) THEN 'all'
    ELSE 'partial'
  END $$;

UPDATE "media" SET monitored = series_monitoring(id, "monitorNewSeasons") <> 'none'
 WHERE "type" = 'series' AND monitored IS DISTINCT FROM (series_monitoring(id, "monitorNewSeasons") <> 'none');
ALTER TABLE "media" ENABLE TRIGGER set_updated_at;
ALTER TABLE "item_groups" ENABLE TRIGGER set_updated_at;

-- A derived "monitored" of a series alone does not bump "updatedAt".
CREATE OR REPLACE FUNCTION media_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  derived text[] := CASE WHEN NEW."type" = 'series' THEN ARRAY['sortCreator', 'lastFileAddedAt', 'monitored']
                         ELSE ARRAY['sortCreator', 'lastFileAddedAt'] END;
BEGIN
  IF NEW."updatedAt" IS NOT DISTINCT FROM OLD."updatedAt"
     AND NOT ((NEW."sortCreator" IS DISTINCT FROM OLD."sortCreator"
               OR NEW."lastFileAddedAt" IS DISTINCT FROM OLD."lastFileAddedAt"
               OR (NEW."type" = 'series' AND NEW.monitored IS DISTINCT FROM OLD.monitored))
              AND to_jsonb(NEW) - derived = to_jsonb(OLD) - derived) THEN
    NEW."updatedAt" = now();
  END IF;
  RETURN NEW;
END $$;

-- Locks the series first (the order every writer follows), then recomputes the cache.
CREATE FUNCTION sync_series_monitored(ids integer[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM media WHERE id = ANY(ids) AND "type" = 'series' ORDER BY id FOR NO KEY UPDATE;
  UPDATE media SET monitored = series_monitoring(id, "monitorNewSeasons") <> 'none'
   WHERE id = ANY(ids) AND "type" = 'series'
     AND monitored IS DISTINCT FROM (series_monitoring(id, "monitorNewSeasons") <> 'none');
END $$;

CREATE FUNCTION item_groups_sync_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_series_monitored((SELECT array_agg(DISTINCT "mediaId") FROM new_rows WHERE "mediaId" IS NOT NULL));
  RETURN NULL;
END $$;
CREATE FUNCTION item_groups_sync_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_series_monitored((SELECT array_agg(DISTINCT n."mediaId") FROM new_rows n JOIN old_rows o USING (id)
    WHERE n."mediaId" IS NOT NULL AND (n.monitored IS DISTINCT FROM o.monitored OR n."number" IS DISTINCT FROM o."number")));
  RETURN NULL;
END $$;
CREATE FUNCTION item_groups_sync_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_series_monitored((SELECT array_agg(DISTINCT "mediaId") FROM old_rows WHERE "mediaId" IS NOT NULL));
  RETURN NULL;
END $$;
CREATE TRIGGER item_groups_sync_insert AFTER INSERT ON "item_groups"
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION item_groups_sync_insert();
CREATE TRIGGER item_groups_sync_update AFTER UPDATE ON "item_groups"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION item_groups_sync_update();
CREATE TRIGGER item_groups_sync_delete AFTER DELETE ON "item_groups"
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION item_groups_sync_delete();

-- A new series starts as its policy says; a written value that disagrees with the seasons is a bug.
CREATE FUNCTION media_series_monitored() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derived boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.monitored := NEW."monitorNewSeasons";
  ELSE
    derived := series_monitoring(NEW.id, NEW."monitorNewSeasons") <> 'none';
    IF NEW."monitorNewSeasons" IS DISTINCT FROM OLD."monitorNewSeasons" OR OLD."type" <> 'series' THEN
      NEW.monitored := derived;
    ELSIF NEW.monitored IS DISTINCT FROM OLD.monitored AND NEW.monitored IS DISTINCT FROM derived THEN
      RAISE EXCEPTION 'media.monitored of series % is derived from its seasons', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER series_monitored_insert BEFORE INSERT ON "media"
  FOR EACH ROW WHEN (NEW."type" = 'series') EXECUTE FUNCTION media_series_monitored();
CREATE TRIGGER series_monitored_update BEFORE UPDATE ON "media"
  FOR EACH ROW WHEN (NEW."type" = 'series') EXECUTE FUNCTION media_series_monitored();
