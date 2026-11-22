-- The home calendar filters episodes and comic issues by air date.
CREATE INDEX "IDX_items_airDate" ON items ("airDate") WHERE "airDate" IS NOT NULL;
