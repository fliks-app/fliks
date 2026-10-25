CREATE INDEX IF NOT EXISTS "IDX_media_title_trgm" ON "media" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IDX_media_originalTitle_trgm" ON "media" USING gin ("originalTitle" gin_trgm_ops);
