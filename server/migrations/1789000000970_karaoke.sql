-- Stems of a track made by the engine's Separate job (karaoke.md rule 11)
CREATE TABLE "derived_audio" (
  "id" serial NOT NULL,
  "mediaFileId" integer NOT NULL,
  "kind" text NOT NULL CONSTRAINT "CK_derived_audio_kind" CHECK ("kind" IN ('vocals', 'instrumental', 'guide')),
  "model" text NOT NULL,
  "modelVersion" text NOT NULL,
  "provider" text NOT NULL,
  "path" text NOT NULL,
  "size" bigint NOT NULL CONSTRAINT "CK_derived_audio_size" CHECK ("size" >= 0),
  "durationMs" integer NOT NULL,
  "lastUsedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_derived_audio" PRIMARY KEY ("id"),
  CONSTRAINT "FK_derived_audio_media_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "UQ_derived_audio_file_kind" ON "derived_audio" ("mediaFileId", "kind");
CREATE INDEX "IDX_derived_audio_last_used" ON "derived_audio" ("lastUsedAt");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "derived_audio" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
