import { Injectable, signal } from '@angular/core';

export interface DisplaySettings {
  /** Show the page-wide fanart background on the home page. */
  homeBackground: boolean;
}

const STORAGE_KEY = 'display.settings';

const DEFAULTS: DisplaySettings = {
  homeBackground: true,
};

@Injectable({ providedIn: 'root' })
export class DisplaySettingsService {
  readonly settings = signal<DisplaySettings>(this.load());

  private load(): DisplaySettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DisplaySettings>;
        return { ...DEFAULTS, ...parsed };
      }
    } catch { /* ignore */ }
    return { ...DEFAULTS };
  }

  save(settings: DisplaySettings): void {
    this.settings.set(settings);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* private mode / SSR */ }
  }

  get(): DisplaySettings {
    return this.settings();
  }
}
