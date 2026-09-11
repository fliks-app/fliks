import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import { StreamLifetime } from './lifetime-constants';
import { envTonemapCurve } from './transcoding/ffmpeg-filter-graph';
import { envRenderNode } from './transcoding/hw-device';
import { tonemapAlgoOverride } from './transcoding/tonemap-path';
import type { TonemapCurve } from './transcoding/codec/types';
import type { TonemapAlgo } from './transcoding/types';

export type { TonemapAlgo, TonemapCurve };

export interface StreamingSettings {
  segmentDuration: number;
  qsvPreset:
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow';
  /** HDR → SDR tone-mapping algorithm. See {@link TonemapAlgo}. Falls back to
   *  `TRANSCODE_TONEMAP_ALGO`, then `'auto'`, which resolves per host from the
   *  boot probes. */
  tonemapAlgo: TonemapAlgo;
  /** HDR → SDR tone-map curve for the OpenCL/CPU paths (the vpp_qsv and
   *  tonemap_vaapi LUTs ignore it). Falls back to `TRANSCODE_TONEMAP_CURVE`,
   *  then `hable`. */
  tonemapCurve: TonemapCurve;
  /** Transcode-cache disk budget in bytes, and how long an untouched entry
   *  survives. Both fall back to the `TRANSCODE_CACHE_*` env defaults. */
  cacheMaxBytes: number;
  cacheTtlMs: number;
  /** Concurrent background ffmpeg jobs, or null to keep the cgroup/CPU-derived
   *  budget. Caps scans, thumbnails and marker detection, not playback. */
  ffmpegSlots: number | null;
  /**
   * What the "Auto" quality resolves to when a compatible source could be
   * direct-played:
   *   - `'directplay'` (default): serve the original untouched — zero
   *     transcoding, but no adaptive bitrate on direct-play sources.
   *   - `'abr'`: always route "Auto" through the adaptive HLS ladder so the
   *     bitrate follows the network, at the cost of transcoding every "Auto"
   *     playback.
   * Explicit quality picks are unaffected either way.
   */
  autoQualityMode: AutoQualityMode;
  /**
   * Whether detected black bars (letterbox/pillarbox) are cropped during
   * playback. Cropping forces a re-encode, so on low-power servers an admin
   * can disable it (default `true`) to let otherwise-compatible sources
   * Direct Play / remux with the black bars intact instead of transcoding.
   */
  autoCropEnabled: boolean;
  /** GPU render node for hardware transcoding, or `'auto'` to let the host
   *  pick. On a multi-GPU box, pinning a specific `/dev/dri/renderD*` keeps
   *  sessions off the wrong adapter. Falls back to `FLIKS_VAAPI_RENDER_NODE`. */
  gpuRenderNode: string;
  /**
   * When embedded subtitles get extracted to WebVTT. Pulling a subtitle out of
   * a container means reading the whole file, so the choice is where to spend
   * that read:
   *   - `'playback'` (default): when a file starts playing, so the wait is gone
   *     by the time anyone opens the subtitle menu, and only for what is watched.
   *   - `'import'`: also at import and rescan — every file ready up front, at the
   *     cost of reading a whole library that may never be watched with subtitles.
   *   - `'off'`: only when a client actually requests a track.
   * Every mode still extracts on demand; they only differ on what runs ahead.
   */
  subtitlePrewarm: SubtitlePrewarm;
}

export type AutoQualityMode = 'directplay' | 'abr';
export type SubtitlePrewarm = 'off' | 'playback' | 'import';

const KEYS = [
  'streaming_segment_duration',
  'streaming_qsv_preset',
  'streaming_tonemap_algo',
  'streaming_tonemap_curve',
  'streaming_cache_max_gb',
  'streaming_cache_ttl_hours',
  'streaming_ffmpeg_slots',
  'streaming_auto_quality_mode',
  'streaming_auto_crop_enabled',
  'streaming_gpu_render_node',
  'streaming_subtitle_prewarm',
] as const;

const TONEMAP_ALGOS: TonemapAlgo[] = ['auto', 'opencl', 'vaapi', 'qsv'];
const TONEMAP_CURVES: TonemapCurve[] = ['hable', 'mobius', 'reinhard'];
const GB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;

const AUTO_QUALITY_MODES: AutoQualityMode[] = ['directplay', 'abr'];
const SUBTITLE_PREWARMS: SubtitlePrewarm[] = ['off', 'playback', 'import'];

/** A stored number that is missing, malformed or <= 0 means "no admin value":
 *  the env/derived default stands rather than a zero budget. */
function positive(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

@Injectable()
export class StreamingSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

  private readonly log = new Logger(StreamingSettingsCache.name);
  private warnedEnvShadow = false;

  private cache: StreamingSettings | null = null;
  private inflight: Promise<StreamingSettings> | null = null;
  /** Bumped on every change so an in-flight load that was invalidated mid-flight
   *  doesn't commit its now-stale value. */
  private epoch = 0;

  onModuleInit(): void {
    this.settings.addChangeListener((key) => {
      if (key.startsWith('streaming_')) {
        this.cache = null;
        this.inflight = null;
        this.epoch++;
      }
    });
  }

  /** Says once per boot which env vars a saved setting now outranks. A
   *  leftover compose entry that silently loses is worse than one that shouts.
   *  Values are the resolved ones, so an ignored setting isn't reported. */
  private warnEnvShadowed(shadowed: Record<string, string | number | null>): void {
    if (this.warnedEnvShadow) return;
    this.warnedEnvShadow = true;
    for (const [env, value] of Object.entries(shadowed)) {
      if (value == null || !process.env[env]) continue;
      this.log.warn(
        `${env} is set but ignored: the admin setting (${value}) wins. Remove it from your compose file.`,
      );
    }
  }

  async get(): Promise<StreamingSettings> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    const epoch = this.epoch;
    this.inflight = (async () => {
      try {
        const s = await this.load();
        if (this.epoch === epoch) this.cache = s;
        return s;
      } finally {
        // Clear so a rejected load can be retried, and so a fresh read after an
        // invalidation isn't handed this superseded promise.
        if (this.epoch === epoch) this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async load(): Promise<StreamingSettings> {
    const values = await Promise.all(KEYS.map((k) => this.settings.get(k)));
    const [
      duration,
      qsvPreset,
      tonemapAlgo,
      tonemapCurve,
      cacheMaxGb,
      cacheTtlHours,
      ffmpegSlots,
      autoQualityMode,
      autoCropEnabled,
      gpuRenderNode,
      subtitlePrewarm,
    ] = values;

    const algo = TONEMAP_ALGOS.includes(tonemapAlgo as TonemapAlgo)
      ? (tonemapAlgo as TonemapAlgo)
      : 'auto';
    const curve = TONEMAP_CURVES.includes(tonemapCurve as TonemapCurve)
      ? (tonemapCurve as TonemapCurve)
      : null;
    const maxGb = positive(cacheMaxGb);
    const ttlHours = positive(cacheTtlHours);
    const slots = positive(ffmpegSlots);
    // 'auto' (or unset) lets the host pick the default render node.
    const renderNode = gpuRenderNode?.trim() || 'auto';

    this.warnEnvShadowed({
      TRANSCODE_TONEMAP_ALGO: algo === 'auto' ? null : algo,
      TRANSCODE_TONEMAP_CURVE: curve,
      TRANSCODE_CACHE_MAX_BYTES: maxGb != null ? `${maxGb} GB` : null,
      TRANSCODE_CACHE_TTL_MS: ttlHours != null ? `${ttlHours} h` : null,
      FLIKS_FFMPEG_SLOTS: slots,
      FLIKS_VAAPI_RENDER_NODE: renderNode === 'auto' ? null : renderNode,
    });

    return {
      segmentDuration: parseFloat(duration ?? '3') || 3,
      qsvPreset: (qsvPreset ?? 'faster') as StreamingSettings['qsvPreset'],
      // Every value below is fully resolved: downstream reads one number or one
      // string and never consults the environment again.
      tonemapAlgo: algo === 'auto' ? (tonemapAlgoOverride() ?? 'auto') : algo,
      tonemapCurve: curve ?? envTonemapCurve() ?? 'hable',
      cacheMaxBytes:
        maxGb != null ? Math.round(maxGb * GB) : StreamLifetime.cacheMaxBytes(),
      cacheTtlMs:
        ttlHours != null
          ? Math.round(ttlHours * HOUR_MS)
          : StreamLifetime.cacheTtlMs(),
      ffmpegSlots: slots,
      autoQualityMode: AUTO_QUALITY_MODES.includes(
        autoQualityMode as AutoQualityMode,
      )
        ? (autoQualityMode as AutoQualityMode)
        : 'directplay',
      // Default on (preserve current behaviour); only the explicit string
      // 'false' disables cropping.
      autoCropEnabled: autoCropEnabled !== 'false',
      gpuRenderNode: renderNode === 'auto' ? (envRenderNode() ?? 'auto') : renderNode,
      subtitlePrewarm: SUBTITLE_PREWARMS.includes(
        subtitlePrewarm as SubtitlePrewarm,
      )
        ? (subtitlePrewarm as SubtitlePrewarm)
        : 'playback',
    };
  }
}
