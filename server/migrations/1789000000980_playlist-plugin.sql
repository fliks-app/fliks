-- The plugin that created a playlist: `playlist.sync` writes only the playlists it created (plugins.md rule 62)
ALTER TABLE "playlists" ADD COLUMN "pluginId" varchar(255);
CREATE UNIQUE INDEX "UQ_playlists_plugin_owner_name" ON "playlists" ("ownerId", "pluginId", "name")
  WHERE "pluginId" IS NOT NULL;
