import { Injectable, signal } from '@angular/core';

export interface DisplaySettings {
  /** Show the page-wide fanart background on the home page. */
  homeBackground: boolean;
  /** Filter home's "Recently added" + "Coming soon" rows to media the user requested. */
  onlyMyRequests: boolean;
  /** UI language override (ISO 639-1). Empty = follow the browser/OS language. */
  language: string;
  /** Desaturate the still of an episode that hasn't aired yet. */
  grayUnreleased: boolean;
}

const STORAGE_KEY = 'display.settings';

const DEFAULTS: DisplaySettings = {
  homeBackground: true,
  onlyMyRequests: false,
  language: '',
  grayUnreleased: true,
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

  save(patch: Partial<DisplaySettings>): void {
    const next = { ...this.settings(), ...patch };
    this.settings.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* private mode / SSR */ }
  }

  get(): DisplaySettings {
    return this.settings();
  }
}
