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

/** A server URL the user connected to; `name` is an optional alias, `lastUsername` pre-fills the login form. */
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
  /** Standalone app with no backend serving its shell (see {@link IS_STANDALONE_BUNDLE}); a plain boolean keeps call sites non-reactive. */
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

  /** Follows the host's first redirect (e.g. http to https): a 301/302 turns the login POST into a GET. Best effort, keeps the entered URL on network/CORS failure. */
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

  /** An empty name clears the alias. A new URL replaces any other entry already on it.
   *  Resolves to the entry's URL after the change. */
  async updateKnownServer(url: string, changes: { name: string; url: string }): Promise<string> {
    const cleaned = url.replace(/\/+$/, '');
    const nextUrl = changes.url.trim().replace(/\/+$/, '') || cleaned;
    const name = changes.name.trim() || null;
    this._knownServers.set(
      this._knownServers()
        .filter((s) => s.url === cleaned || s.url !== nextUrl)
        .map((s) => (s.url === cleaned ? { ...s, url: nextUrl, name } : s)),
    );
    await this.persistKnownServers();
    return nextUrl;
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
