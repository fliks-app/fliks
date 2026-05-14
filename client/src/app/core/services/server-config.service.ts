import { Injectable, signal, computed, inject } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { DeviceService } from './device.service';

const STORAGE_KEY = 'fliks_server_url';
const KNOWN_SERVERS_KEY = 'fliks_known_servers';
const MAX_KNOWN_SERVERS = 10;

/**
 * One server URL the user previously connected to. The `name` is an optional
 * user-supplied alias; `lastUsername` lets the login form pre-fill on return.
 */
export interface KnownServer {
  url: string;
  name: string | null;
  lastUsedAt: number;
  lastUsername: string | null;
}

@Injectable({ providedIn: 'root' })
export class ServerConfigService {
  private readonly _serverUrl = signal('');
  private readonly _knownServers = signal<KnownServer[]>([]);

  private readonly device = inject(DeviceService);

  readonly serverUrl = this._serverUrl.asReadonly();
  readonly knownServers = this._knownServers.asReadonly();
  readonly isConfigured = computed(() => this._serverUrl().length > 0);
  readonly isNative = Capacitor.isNativePlatform();
  /** Standalone bundles (Capacitor native or Smart TV) ship without a host
   * backend and need an explicit server URL. Web builds are served by the
   * backend and use relative `/api` URLs. */
  readonly requiresServerUrl = computed(() => this.isNative || this.device.isTv());

  async load(): Promise<void> {
    await Promise.all([this.loadActiveUrl(), this.loadKnownServers()]);
  }

  private async loadActiveUrl(): Promise<void> {
    const value = await this.readPreference(STORAGE_KEY);
    if (value) this._serverUrl.set(value);
  }

  private async loadKnownServers(): Promise<void> {
    const raw = await this.readPreference(KNOWN_SERVERS_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as KnownServer[];
      if (Array.isArray(parsed)) this._knownServers.set(parsed);
    } catch {
      /* corrupt JSON — ignore and start fresh */
    }
  }

  async save(url: string): Promise<void> {
    const cleaned = url.replace(/\/+$/, '');
    this._serverUrl.set(cleaned);
    await this.writePreference(STORAGE_KEY, cleaned);
  }

  async clear(): Promise<void> {
    this._serverUrl.set('');
    await this.removePreference(STORAGE_KEY);
  }

  /** Append the URL to the known list, or bump its `lastUsedAt` if already present. */
  async addOrTouchKnownServer(
    url: string,
    opts?: { name?: string; username?: string },
  ): Promise<void> {
    const cleaned = url.replace(/\/+$/, '');
    if (!cleaned) return;
    const existing = this._knownServers().find((s) => s.url === cleaned);
    const merged: KnownServer = {
      url: cleaned,
      name: opts?.name ?? existing?.name ?? null,
      lastUsedAt: Date.now(),
      lastUsername: opts?.username ?? existing?.lastUsername ?? null,
    };
    const next = [merged, ...this._knownServers().filter((s) => s.url !== cleaned)]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_KNOWN_SERVERS);
    this._knownServers.set(next);
    await this.persistKnownServers();
  }

  /** Remove a server from the list. Caller is expected to ensure it isn't the active one. */
  async forgetKnownServer(url: string): Promise<void> {
    const cleaned = url.replace(/\/+$/, '');
    this._knownServers.set(this._knownServers().filter((s) => s.url !== cleaned));
    await this.persistKnownServers();
  }

  async renameKnownServer(url: string, name: string): Promise<void> {
    const cleaned = url.replace(/\/+$/, '');
    const trimmed = name.trim() || null;
    this._knownServers.set(
      this._knownServers().map((s) => (s.url === cleaned ? { ...s, name: trimmed } : s)),
    );
    await this.persistKnownServers();
  }

  /** Username last seen on the active server, used to pre-fill the login form. */
  lastUsernameForActiveServer(): string | null {
    const active = this._serverUrl();
    if (!active) return null;
    return this._knownServers().find((s) => s.url === active)?.lastUsername ?? null;
  }

  resolveUrl(path: string): string {
    if (!this.requiresServerUrl() || !this._serverUrl()) return path;
    // Absolute URLs (e.g. raw TMDB images) must not be re-prefixed with the
    // server host — would produce https://server/https://image.tmdb.org/...
    if (/^https?:\/\//i.test(path)) return path;
    return this._serverUrl() + path;
  }

  // ── Storage helpers — Preferences on native, localStorage on web ──

  private async readPreference(key: string): Promise<string | null> {
    if (this.isNative) {
      try {
        const { value } = await Preferences.get({ key });
        if (value !== null) return value;
      } catch {
        /* fall through to localStorage */
      }
    }
    return localStorage.getItem(key);
  }

  private async writePreference(key: string, value: string): Promise<void> {
    if (this.isNative) {
      try {
        await Preferences.set({ key, value });
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    localStorage.setItem(key, value);
  }

  private async removePreference(key: string): Promise<void> {
    if (this.isNative) {
      try {
        await Preferences.remove({ key });
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    localStorage.removeItem(key);
  }

  private async persistKnownServers(): Promise<void> {
    await this.writePreference(KNOWN_SERVERS_KEY, JSON.stringify(this._knownServers()));
  }
}
