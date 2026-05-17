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
}

const KEYS = [
  'streaming_segment_duration',
  'streaming_qsv_preset',
  'streaming_qsv_low_power',
  'streaming_tonemap_algo',
] as const;

const TONEMAP_ALGOS: TonemapAlgo[] = ['auto', 'opencl', 'vaapi', 'qsv'];

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
    const [duration, qsvPreset, qsvLowPower, tonemapAlgo] = values;
    return {
      segmentDuration: parseFloat(duration ?? '3') || 3,
      qsvPreset: (qsvPreset ?? 'faster') as StreamingSettings['qsvPreset'],
      qsvLowPower: qsvLowPower === 'true',
      tonemapAlgo: TONEMAP_ALGOS.includes(tonemapAlgo as TonemapAlgo)
        ? (tonemapAlgo as TonemapAlgo)
        : 'auto',
    };
  }
}
