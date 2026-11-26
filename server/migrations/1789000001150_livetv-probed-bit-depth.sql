-- The bit depth the engine probed on a stream, sent back at the next open; NULL for 8 bits or unknown.
ALTER TABLE livetv_channel_streams ADD COLUMN "probedBitDepth" integer;
