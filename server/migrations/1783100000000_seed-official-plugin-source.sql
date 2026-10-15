-- No pinned key: refreshes fall back to the compiled-in OFFICIAL_KEYS.
INSERT INTO "plugin_sources" ("url", "enabled")
       SELECT 'https://fliks-app.github.io/fliks-plugin-catalog/catalog.json'::varchar, true
       WHERE NOT EXISTS (SELECT 1 FROM "plugin_sources" WHERE "url" = 'https://fliks-app.github.io/fliks-plugin-catalog/catalog.json'::varchar);
