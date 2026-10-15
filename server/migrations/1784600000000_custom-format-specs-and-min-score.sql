
      UPDATE "custom_formats" SET "specifications" = COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'type', s->>'implementation',
          'value', s->>'value',
          'negate', COALESCE((s->>'negate')::boolean, false),
          'required', COALESCE((s->>'required')::boolean, false)
        ))
        FROM jsonb_array_elements("specifications") s
        WHERE s->>'implementation' IN (
          'title_regex', 'source', 'resolution', 'language', 'release_flag',
          'release_group', 'edition', 'video_codec', 'audio_codec'
        )
      ), '[]'::jsonb)
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements("specifications") s
        WHERE s ? 'implementation'
      );

DELETE FROM "custom_formats" WHERE jsonb_array_length("specifications") = 0;

ALTER TABLE "custom_formats" RENAME COLUMN "specifications" TO "specs";

ALTER TABLE "quality_profiles" ADD COLUMN IF NOT EXISTS "minCustomFormatScore" integer NOT NULL DEFAULT 0;
