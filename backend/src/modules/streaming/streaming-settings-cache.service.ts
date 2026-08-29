import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';
import type { TonemapAlgo } from './transcoding/types';

export type { TonemapAlgo };

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
  qsvLowPower: boolean;
  /** HDR → SDR tone-mapping algorithm. See {@link TonemapAlgo}. Default
   *  is `'auto'` which currently routes through tonemap_opencl. */
  tonemapAlgo: TonemapAlgo;
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
  /** Admin-selected GPU render node for hardware transcoding, or `'auto'`
   *  (default) to let the host pick. On a multi-GPU box, pinning a specific
   *  `/dev/dri/renderD*` keeps sessions off the wrong adapter. */
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
  'streaming_qsv_low_power',
  'streaming_tonemap_algo',
  'streaming_auto_quality_mode',
  'streaming_auto_crop_enabled',
  'streaming_gpu_render_node',
  'streaming_subtitle_prewarm',
] as const;

const TONEMAP_ALGOS: TonemapAlgo[] = ['auto', 'opencl', 'vaapi', 'qsv'];
const AUTO_QUALITY_MODES: AutoQualityMode[] = ['directplay', 'abr'];
const SUBTITLE_PREWARMS: SubtitlePrewarm[] = ['off', 'playback', 'import'];

@Injectable()
export class StreamingSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

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
      qsvLowPower,
      tonemapAlgo,
      autoQualityMode,
      autoCropEnabled,
      gpuRenderNode,
      subtitlePrewarm,
    ] = values;
    return {
      segmentDuration: parseFloat(duration ?? '3') || 3,
      qsvPreset: (qsvPreset ?? 'faster') as StreamingSettings['qsvPreset'],
      qsvLowPower: qsvLowPower === 'true',
      tonemapAlgo: TONEMAP_ALGOS.includes(tonemapAlgo as TonemapAlgo)
        ? (tonemapAlgo as TonemapAlgo)
        : 'auto',
      autoQualityMode: AUTO_QUALITY_MODES.includes(
        autoQualityMode as AutoQualityMode,
      )
        ? (autoQualityMode as AutoQualityMode)
        : 'directplay',
      // Default on (preserve current behaviour); only the explicit string
      // 'false' disables cropping.
      autoCropEnabled: autoCropEnabled !== 'false',
      // 'auto' (or unset) lets the host pick the default render node.
      gpuRenderNode: gpuRenderNode?.trim() || 'auto',
      subtitlePrewarm: SUBTITLE_PREWARMS.includes(
        subtitlePrewarm as SubtitlePrewarm,
      )
        ? (subtitlePrewarm as SubtitlePrewarm)
        : 'playback',
    };
  }
}
