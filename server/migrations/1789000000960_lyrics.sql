-- Lyrics belong to the track item; the file only stamps the audio they were found in or timed on (music.md rule 61)
CREATE TABLE "lyrics" (
  "id" serial NOT NULL,
  "itemId" integer NOT NULL,
  "mediaFileId" integer,
  "kind" text NOT NULL DEFAULT 'main' CONSTRAINT "CK_lyrics_kind" CHECK ("kind" IN ('main', 'translation', 'pronunciation')),
  "lang" text NOT NULL DEFAULT 'und' CONSTRAINT "CK_lyrics_lang" CHECK ("lang" ~ '^[a-z0-9]{1,8}$'),
  "sync" text NOT NULL CONSTRAINT "CK_lyrics_sync" CHECK ("sync" IN ('none', 'line', 'word')),
  "source" text NOT NULL CONSTRAINT "CK_lyrics_source" CHECK ("source" ~ '^(embedded|sidecar|user|generated|provider:[a-z0-9:-]{1,64})$'),
  "sourceRef" text,
  "offsetMs" integer NOT NULL DEFAULT 0 CONSTRAINT "CK_lyrics_offset" CHECK ("offsetMs" BETWEEN -60000 AND 60000),
  "audioDurationMs" integer,
  "doc" jsonb NOT NULL CONSTRAINT "CK_lyrics_doc" CHECK (jsonb_typeof("doc") = 'object'),
  "raw" text,
  "reviewed" boolean NOT NULL DEFAULT false,
  "preferred" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_lyrics" PRIMARY KEY ("id"),
  CONSTRAINT "FK_lyrics_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE,
  CONSTRAINT "FK_lyrics_media_file" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "UQ_lyrics_item_layer" ON "lyrics" ("itemId", "kind", "lang", "source");
CREATE INDEX "IDX_lyrics_media_file" ON "lyrics" ("mediaFileId");
CREATE TRIGGER set_updated_at BEFORE UPDATE ON "lyrics" FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What a provider answered for a track, so a miss is not asked again at once (music.md rule 68)
CREATE TABLE "lyrics_lookups" (
  "itemId" integer NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL CONSTRAINT "CK_lyrics_lookups_status" CHECK ("status" IN ('found', 'miss', 'instrumental')),
  "checkedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "PK_lyrics_lookups" PRIMARY KEY ("itemId", "provider"),
  CONSTRAINT "FK_lyrics_lookups_item" FOREIGN KEY ("itemId") REFERENCES "items"("id") ON DELETE CASCADE
);
