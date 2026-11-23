-- The setup checklist reads a durable marker; instances that imported before it existed get it from the audit rows.
INSERT INTO app_settings ("key", "value")
SELECT 'data_import_done', 'true'
WHERE EXISTS (
  SELECT 1 FROM commands WHERE status = 'completed' AND name IN ('ImportWatchHistory', 'ImportSeerrRequests')
)
ON CONFLICT ("key") DO NOTHING;
