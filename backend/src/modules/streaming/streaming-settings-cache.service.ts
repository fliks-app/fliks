import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

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
  /** Master switch for the HEVC HDR ladder. When false, HDR sources are
   *  tone-mapped to H.264 SDR for every rung — useful when the HW
   *  encoder can't sustain hevc_qsv Main10. */
  hevcHdrEnabled: boolean;
}

const KEYS = [
  'streaming_segment_duration',
  'streaming_qsv_preset',
  'streaming_qsv_low_power',
  'streaming_hevc_hdr_enabled',
] as const;

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
    const [duration, qsvPreset, qsvLowPower, hevcHdrEnabled] = values;
    return {
      segmentDuration: parseFloat(duration ?? '3') || 3,
      qsvPreset: (qsvPreset ?? 'faster') as StreamingSettings['qsvPreset'],
      qsvLowPower: qsvLowPower === 'true',
      // Default true: HDR sources get the HEVC HDR ladder. Operators opt
      // out via the streaming settings page when their HW path can't
      // sustain hevc_qsv Main10.
      hevcHdrEnabled: hevcHdrEnabled !== 'false',
    };
  }
}
