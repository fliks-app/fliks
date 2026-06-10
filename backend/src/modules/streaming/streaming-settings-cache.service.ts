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
}

export type AutoQualityMode = 'directplay' | 'abr';

const KEYS = [
  'streaming_segment_duration',
  'streaming_qsv_preset',
  'streaming_qsv_low_power',
  'streaming_tonemap_algo',
  'streaming_auto_quality_mode',
] as const;

const TONEMAP_ALGOS: TonemapAlgo[] = ['auto', 'opencl', 'vaapi', 'qsv'];
const AUTO_QUALITY_MODES: AutoQualityMode[] = ['directplay', 'abr'];

@Injectable()
export class StreamingSettingsCache implements OnModuleInit {
  constructor(private readonly settings: SettingsService) {}

  private cache: StreamingSettings | null = null;
  private inflight: Promise<StreamingSettings> | null = null;

  onModuleInit(): void {
    this.settings.addChangeListener((key) => {
      if (key.startsWith('streaming_')) {
        this.cache = null;
        this.inflight = null;
      }
    });
  }

  async get(): Promise<StreamingSettings> {
    if (this.cache) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.load().then((s) => {
      this.cache = s;
      this.inflight = null;
      return s;
    });
    return this.inflight;
  }

  private async load(): Promise<StreamingSettings> {
    const values = await Promise.all(KEYS.map((k) => this.settings.get(k)));
    const [duration, qsvPreset, qsvLowPower, tonemapAlgo, autoQualityMode] =
      values;
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
    };
  }
}
