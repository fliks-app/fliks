import { Injectable, signal } from '@angular/core';

export interface DisplaySettings {
  /** Show the page-wide fanart background on the home page. */
  homeBackground: boolean;
  /** Filter home's "Recently added" + "Coming soon" rows to media the user requested. */
  onlyMyRequests: boolean;
  /** UI language override (ISO 639-1). Empty = follow the browser/OS language. */
  language: string;
}

const STORAGE_KEY = 'display.settings';
const LEGACY_ONLY_MY_REQUESTS_KEY = 'fliks.home.onlyMyRequests';

const DEFAULTS: DisplaySettings = {
  homeBackground: true,
  onlyMyRequests: false,
  language: '',
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
      // First load after the toggle moved out of home — pick up the old key
      // so the user's preference survives the migration.
      const legacy = localStorage.getItem(LEGACY_ONLY_MY_REQUESTS_KEY);
      if (legacy !== null) {
        return { ...DEFAULTS, onlyMyRequests: legacy === 'true' };
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
