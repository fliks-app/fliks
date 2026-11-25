-- A library always has an icon and a colour: the first of each list the settings offer.
ALTER TABLE "libraries" DISABLE TRIGGER set_updated_at;
UPDATE "libraries" SET icon = 'library' WHERE icon IS NULL OR icon = '';
UPDATE "libraries" SET color = 'primary' WHERE color IS NULL OR color = '';
ALTER TABLE "libraries" ENABLE TRIGGER set_updated_at;

ALTER TABLE "libraries" ALTER COLUMN icon SET DEFAULT 'library', ALTER COLUMN icon SET NOT NULL;
ALTER TABLE "libraries" ALTER COLUMN color SET DEFAULT 'primary', ALTER COLUMN color SET NOT NULL;
