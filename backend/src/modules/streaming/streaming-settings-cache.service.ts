import { Injectable, OnModuleInit } from '@nestjs/common';
import { SettingsService } from '../settings/settings.service';

export interface StreamingSettings {
  segmentDuration: number;
  initTime: number;
  qsvPreset:
    | 'veryfast'
    | 'faster'
    | 'fast'
    | 'medium'
    | 'slow'
    | 'slower'
    | 'veryslow';
  qsvLowPower: boolean;
}

const KEYS = [
  'streaming_segment_duration',
  'streaming_init_time',
  'streaming_qsv_preset',
  'streaming_qsv_low_power',
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
    const [duration, initTime, qsvPreset, qsvLowPower] = values;
    return {
      segmentDuration: parseFloat(duration ?? '3') || 3,
      initTime: parseFloat(initTime ?? '1') || 1,
      qsvPreset: (qsvPreset ?? 'faster') as StreamingSettings['qsvPreset'],
      qsvLowPower: qsvLowPower === 'true',
    };
  }
}
