-- `gpuPlaybackBeforePause` becomes a count of hardware reads (0 = never pause).
UPDATE "app_settings"
   SET "value" = jsonb_set("value"::jsonb, '{gpuPlaybackBeforePause}',
         CASE WHEN "value"::jsonb->'gpuPlaybackBeforePause' = 'false' THEN '0'::jsonb ELSE '1'::jsonb END)::text
 WHERE "key" = 'optimize_settings'
   AND jsonb_typeof("value"::jsonb->'gpuPlaybackBeforePause') = 'boolean';

-- `subtitle_ocr_delete_source` is replaced by `subtitles.image: ocr_then_drop` in a profile.
INSERT INTO "optimize_profiles" ("name", "document")
SELECT 'Image subtitles to text', '{
  "eligible": {"min_age_days": 0, "skip_hardlinked": true},
  "video": {"enabled": false, "when": {"codec": [], "min_bitrate": null, "only_if_transcoding_here": false, "skip_hdr10plus_dv": true},
            "codec": "auto", "goal": "space", "quality": "balanced", "max_resolution": "source", "prefer_software": false,
            "software_max_hours": 12, "too_slow": "hardware", "crop_in_file": false},
  "audio": {"languages": [], "drop_other_languages": false, "drop": [], "default": [], "reorder": false, "incompatible": "keep"},
  "subtitles": {"languages": [], "drop_other_languages": false, "image": "ocr_then_drop", "reorder": false},
  "file": {"clean": false, "container": "keep", "rename_tokens": false},
  "guards": {"min_savings_pct": 0, "vmaf_sample": "off"}
}'::jsonb
WHERE EXISTS (SELECT 1 FROM "app_settings" WHERE "key" = 'subtitle_ocr_delete_source' AND "value" = 'true');

DELETE FROM "app_settings" WHERE "key" = 'subtitle_ocr_delete_source';

-- When the output was handed back: with `startedAt`, the encoding time the completion estimate uses.
ALTER TABLE "jobs" ADD COLUMN "encodedAt" timestamptz;

-- Jobs queued before the engine plan carried every change hold a partial plan: queue them again.
UPDATE "jobs" SET "state" = 'cancelled', "finishedAt" = now(), "updatedAt" = now(),
       "error" = '{"class":"cancelled","message":"queued with an incomplete plan; queue the file again"}'::jsonb
 WHERE "state" = 'queued' AND "kind" = 'optimize';
