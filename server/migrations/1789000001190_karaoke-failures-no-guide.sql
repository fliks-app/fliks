-- The guide stem is no longer made (karaoke.md rule 11); the boot sweep removes its files
DELETE FROM "derived_audio" WHERE "kind" = 'guide';
ALTER TABLE "derived_audio" DROP CONSTRAINT "CK_derived_audio_kind",
  ADD CONSTRAINT "CK_derived_audio_kind" CHECK ("kind" IN ('vocals', 'instrumental'));

-- The last failure of a track's preparation and the lyrics its aligner rejected (karaoke.md rule 8)
CREATE TABLE "karaoke_failures" (
  "itemId" integer NOT NULL,
  "error" jsonb,
  "lyricsError" jsonb,
  "rejectedBy" text,
  "rejectedText" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_karaoke_failures" PRIMARY KEY ("itemId"),
  CONSTRAINT "FK_karaoke_failures_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE
);
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "karaoke_failures" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
