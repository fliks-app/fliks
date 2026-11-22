-- The field order of a live upstream's video is kept with its other probed facts, so a session opens with it known.
ALTER TABLE livetv_channel_streams ADD COLUMN "probedFieldOrder" character varying(16);
