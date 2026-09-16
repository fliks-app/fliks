import { Entity, Column } from 'typeorm';
import { BaseEntity } from '../../../common/entities/base.entity';

/**
 * Generic key-value store for application settings.
 * Keys are stable identifiers; values are stored as text (JSON-encoded if needed).
 *
 * Known keys:
 *   naming_movie_format   — e.g. "{Movie.Title} ({Movie.Year}) [{Quality.Name}]"
 *   naming_series_format        — e.g. "{Series Title} - S{season:00}E{episode:00} - {Episode Title}"
 *   naming_movie_folder_format  — e.g. "{Movie Title} ({Release Year})"
 *   naming_series_folder_format — e.g. "{Series Title}"
 *   naming_season_folder_format — e.g. "Season {season:00}"
 *   companion_file_extensions — comma-separated list, e.g. ".nfo,.srt,.jpg"
 *   search_missing_auto   — "true" | "false"
 *   markers_auto_detect_on_import — "true" | "false" (intro/outro detection after an import)
 *   sprites_auto_generate_on_import — "true" | "false" (seek sprites after an import)
 *   rss_sync_interval     — minutes, e.g. "15"
 *   streaming_auto_quality_mode — "directplay" | "abr" (how "Auto" quality resolves)
 *   streaming_tonemap_curve — "hable" | "mobius" | "reinhard" (HDR→SDR curve)
 *   streaming_cache_max_gb / streaming_cache_ttl_hours — transcode-cache budget
 *   streaming_ffmpeg_slots — concurrent background ffmpeg jobs; absent = auto
 *   subtitle_translation_enabled — "true" | "false" (machine translation)
 *   subtitle_translation_engine — "gemini" | "openai" | "libretranslate"
 *   subtitle_translation_max_concurrency — parallel translation runs, e.g. "1"
 *   subtitle_translation_gemini_api_key / _gemini_model — Gemini creds + model
 *   subtitle_translation_openai_base_url / _openai_api_key / _openai_model —
 *     OpenAI-compatible endpoint (Groq, OpenRouter, Ollama…)
 *   subtitle_translation_libretranslate_url / _libretranslate_api_key —
 *     self-hosted LibreTranslate server
 *   plugins.auto_update  — "false" disables the daily plugin update pass; absent or
 *     anything else means on. Not a `plugin.<id>.*` key, so an uninstall never clears it.
 *   livetv_guide_days_past / livetv_guide_days_future — guide retention window
 *     in days (2 / 7). Programmes outside it are dropped on ingest and pruned.
 *   livetv_segment_seconds — live HLS segment length (2)
 *   livetv_timeshift_minutes — retained live window, the pause/rewind buffer (15).
 *     Costs disk: a 2 s segment of a 2 Mbps channel is about 528 KB.
 *   livetv_channel_idle_seconds — how long a viewerless live session stays warm
 *     so zapping back is instant (30)
 *   livetv_probe_seconds — ffmpeg input probe width (3). Below one source GOP,
 *     ffmpeg cannot find the stream dimensions and the channel looks dead.
 *   livetv_stale_stream_days — how long a stream absent from a refresh is kept
 *     before deletion (7). Absence from one fetch is not proof it is gone, and
 *     deleting cascades to channels, their numbering and every user's favourites.
 *   livetv_slot_release_seconds — how long a closed upstream still counts against
 *     the provider limit (15), which is how long panels take to free a slot.
 *   livetv_restricted_groups — JSON array of channel groups that need an explicit
 *     per-user grant. Adult groups are added here automatically on first sight.
 *   livetv_fast_zap — "true"/"false" override. Unset, the server prefers a
 *     transcode over a copy only where hardware encoding exists, because that
 *     is the whole condition under which it reaches the first segment sooner.
 */
@Entity('app_settings')
export class AppSetting extends BaseEntity {
  @Column({ unique: true })
  key: string;

  @Column({ type: 'text', nullable: true })
  value: string | null;
}
