import { Injectable, signal } from '@angular/core';

export interface CastSettings {
  hdr: boolean;
  maxQuality: string; // 'original' | '2160p' | '1080p' | '720p' | '480p'
  audioChannels: number; // 2 = stereo, 6 = 5.1, 8 = 7.1
}

const STORAGE_KEY = 'cast.settings';

const DEFAULTS: CastSettings = {
  hdr: false,
  maxQuality: '1080p',
  audioChannels: 2,
};

@Injectable({ providedIn: 'root' })
export class CastSettingsService {
  readonly settings = signal<CastSettings>(this.load());

  private load(): CastSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...DEFAULTS };
  }

  save(settings: CastSettings) {
    this.settings.set(settings);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  get(): CastSettings {
    return this.settings();
  }
}
