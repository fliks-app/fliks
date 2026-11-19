-- The plugin whose `playlist.sync` created the row; null for a row a user added.
ALTER TABLE "playlist_items" ADD COLUMN "syncedBy" varchar(255);
