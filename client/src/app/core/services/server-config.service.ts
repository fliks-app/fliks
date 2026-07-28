import { Injectable, signal, computed } from '@angular/core';
import { IS_STANDALONE_BUNDLE } from '../utils/standalone-bundle';
import {
  readPreference,
  removePreference,
  writePreference,
} from '../utils/preference-storage';

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

  readonly serverUrl = this._serverUrl.asReadonly();
  readonly knownServers = this._knownServers.asReadonly();
  readonly isConfigured = computed(() => this._serverUrl().length > 0);
  /** "Native" = the app runs standalone, with no backend host serving its
   * shell. See {@link IS_STANDALONE_BUNDLE}. Plain boolean so the dozens of
   * existing `if (serverConfig.isNative)` call sites stay non-reactive. */
  readonly isNative = IS_STANDALONE_BUNDLE;
  /** @deprecated Same as `isNative` since Smart TV got folded in.
   *  Kept as a signal alias for call sites still using it. */
  readonly requiresServerUrl = computed(() => this.isNative);

  async load(): Promise<void> {
    await Promise.all([this.loadActiveUrl(), this.loadKnownServers()]);
  }

  private async loadActiveUrl(): Promise<void> {
    const value = await readPreference(STORAGE_KEY);
    if (value) this._serverUrl.set(value);
  }

  private async loadKnownServers(): Promise<void> {
    const raw = await readPreference(KNOWN_SERVERS_KEY);
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
    const canonical = this.isNative
      ? await this.resolveCanonicalUrl(cleaned)
      : cleaned;
    this._serverUrl.set(canonical);
    await writePreference(STORAGE_KEY, canonical);
  }

  /**
   * Follow any redirect the host issues on its first request (e.g. an
   * http→https upgrade) and return the post-redirect base. A 301/302 downgrades
   * a POST to GET, so a server reached through such a redirect would turn the
   * login POST into `GET /api/auth/login`. Storing the canonical base makes
   * every API call hit the final host directly. Best effort: the entered URL is
   * kept on any network/CORS failure.
   */
  private async resolveCanonicalUrl(base: string): Promise<string> {
    if (!base) return base;
    const probe = '/api/auth/me';
    try {
      const res = await fetch(base + probe, { method: 'GET', redirect: 'follow' });
      const idx = res.url.indexOf(probe);
      if (idx > 0) return res.url.slice(0, idx);
    } catch {
      /* unreachable / blocked — keep the entered URL */
    }
    return base;
  }

  async clear(): Promise<void> {
    this._serverUrl.set('');
    await removePreference(STORAGE_KEY);
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

  private async persistKnownServers(): Promise<void> {
    await writePreference(KNOWN_SERVERS_KEY, JSON.stringify(this._knownServers()));
  }
}
