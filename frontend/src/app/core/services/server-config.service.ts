import { Injectable, signal, computed } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const STORAGE_KEY = 'fliks_server_url';

@Injectable({ providedIn: 'root' })
export class ServerConfigService {
  private readonly _serverUrl = signal('');

  readonly serverUrl = this._serverUrl.asReadonly();
  readonly isConfigured = computed(() => this._serverUrl().length > 0);
  readonly isNative = Capacitor.isNativePlatform();

  async load(): Promise<void> {
    if (!this.isNative) return;
    try {
      const { value } = await Preferences.get({ key: STORAGE_KEY });
      if (value) this._serverUrl.set(value);
    } catch {
      // Preferences not available — try localStorage fallback
      const value = localStorage.getItem(STORAGE_KEY);
      if (value) this._serverUrl.set(value);
    }
  }

  async save(url: string): Promise<void> {
    const cleaned = url.replace(/\/+$/, '');
    this._serverUrl.set(cleaned);
    if (this.isNative) {
      try {
        await Preferences.set({ key: STORAGE_KEY, value: cleaned });
      } catch {
        localStorage.setItem(STORAGE_KEY, cleaned);
      }
    }
  }

  resolveUrl(path: string): string {
    if (!this.isNative || !this._serverUrl()) return path;
    return this._serverUrl() + path;
  }
}
