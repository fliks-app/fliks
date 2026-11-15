import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom, of } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import type { ConfigPage, SlotId, UiContribution } from '@fliks/plugin-ui';
import type { AcquisitionProvider, PluginUiEntry } from './plugin-ui-response';
import { ServerConfigService } from '../services/server-config.service';
import { SessionStoreService, sessionKey } from '../services/session-store.service';
import { readStored, writeStored } from '../services/party/local-flag';

/** Bounds the boot-blocking wait: a dead plugin endpoint must never hold the splash. */
const FETCH_TIMEOUT_MS = 3000;
const STORAGE_PREFIX = 'fliks.pluginUi::';

/** Fetches `GET /api/plugins/ui` at app init and on a language switch, and caches it; any error, timeout or malformed payload fails open to an empty registry. */
@Injectable({ providedIn: 'root' })
export class PluginUiRegistryService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly sessions = inject(SessionStoreService);
  private readonly translate = inject(TranslateService);
  /** A signal, so a reload after an install or a toggle re-runs every consumer's `computed`
   *  instead of waiting for the next full page load. */
  private readonly entriesSignal = signal<PluginUiEntry[]>([]);

  /** The language of the last request; the initial `use()` also emits `onLangChange`, which must not fetch twice. */
  private requestedLang = this.lang();

  constructor() {
    // The payload carries the plugin strings of one language only.
    this.translate.onLangChange.subscribe(({ lang }) => {
      if (lang !== this.requestedLang) void this.load(true);
    });
  }

  /** Boot read: the registry stored for this server and account applies at once and is revalidated in the background;
   *  only a first boot with nothing stored waits on the network. */
  async boot(): Promise<void> {
    const key = this.storageKey(this.lang());
    const stored = key ? readEntries(key) : null;
    if (!stored) return this.load();
    this.entriesSignal.set(stored);
    void this.load(true);
  }

  /** `keep`: a failed refresh leaves the known entries instead of emptying the registry. */
  async load(keep = false): Promise<void> {
    const lang = (this.requestedLang = this.lang());
    const key = this.storageKey(lang);
    const entries = await firstValueFrom(
      this.http.get<PluginUiEntry[]>('/api/plugins/ui', { params: lang ? { lang } : {} }).pipe(
        timeout(FETCH_TIMEOUT_MS),
        catchError(() => of<PluginUiEntry[] | null>(null)),
      ),
    );
    // A language switch meanwhile started the load of the newer language.
    if (lang !== this.lang()) return;
    if (entries === null && keep) return;
    this.entriesSignal.set(Array.isArray(entries) ? entries : []);
    if (key && Array.isArray(entries)) writeStored(key, JSON.stringify(entries));
  }

  /** Per server, account and language: the payload follows the account's permissions and the language. Null when signed out. */
  private storageKey(lang: string | null): string | null {
    const user = untracked(this.sessions.active)?.user;
    return user ? `${STORAGE_PREFIX}${sessionKey(untracked(this.serverConfig.serverUrl), user.id)}::${lang ?? ''}` : null;
  }

  private lang(): string | null {
    return untracked(this.translate.currentLang) || untracked(this.translate.fallbackLang);
  }

  private get entries(): PluginUiEntry[] {
    return this.entriesSignal();
  }

  private readonly bySlotSignal = computed(() => {
    const bySlot = new Map<SlotId, UiContribution[]>();
    for (const entry of this.entriesSignal()) {
      for (const contribution of entry.contributions ?? []) {
        const list = bySlot.get(contribution.slot);
        if (list) list.push(contribution);
        else bySlot.set(contribution.slot, [contribution]);
      }
    }
    for (const list of bySlot.values()) {
      list.sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return bySlot;
  });

  /** Contributions for one slot, sorted ascending by weight then ascending by id. */
  contributionsFor(slot: SlotId): UiContribution[] {
    return this.bySlotSignal().get(slot) ?? [];
  }

  /** The one contribution (any slot) whose route action points at this path, if any. */
  findRouteContribution(path: string): UiContribution | undefined {
    for (const list of this.bySlotSignal().values()) {
      const found = list.find((c) => c.action.kind === 'route' && c.action.path === path);
      if (found) return found;
    }
    return undefined;
  }

  hasPlugin(pluginId: string): boolean {
    return this.entries.some((e) => e.pluginId === pluginId);
  }

  /** Raw per-plugin entries — needed where a slot's contributions must stay
   *  grouped by the plugin that declared them (settings.page's per-plugin sections). */
  pluginEntries(): readonly PluginUiEntry[] {
    return this.entries;
  }

  configPage(pluginId: string, pageId: string): ConfigPage | undefined {
    return this.entries.find((e) => e.pluginId === pluginId)?.configPages?.find((p) => p.id === pageId);
  }

  /** Acquisition providers in the admin order (`acquisition.order`, never array position). */
  readonly providers = computed<AcquisitionProvider[]>(() =>
    this.entriesSignal()
      .filter((e) => e.acquisition)
      .sort((a, b) => a.acquisition!.order - b.acquisition!.order)
      .map((e) => ({
        pluginId: e.pluginId,
        name: e.name ?? e.pluginId,
        routes: e.acquisition!.routes,
        sources: e.acquisition!.sources,
      })),
  );

  /** Providers with a source serving `kind` and a route for `level`, in order. */
  providersFor(kind: string, level: string): AcquisitionProvider[] {
    return this.providers().filter(
      (p) =>
        p.sources.some((s) => s.kinds.includes(kind)) &&
        (p.routes.byKind[kind] as Record<string, unknown> | undefined)?.[level],
    );
  }

  /** Every plugin's `i18n[lang]` dict combined (undefined if none ship it); ordered by plugin id, first-declared wins, independent of install order. */
  i18nFor(lang: string): Record<string, string> | undefined {
    let merged: Record<string, string> | undefined;
    const ordered = [...this.entries].sort((a, b) => (a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0));
    for (const entry of ordered) {
      const dict = entry.i18n?.[lang];
      if (!dict) continue;
      merged ??= {};
      for (const [key, value] of Object.entries(dict)) {
        if (!(key in merged)) merged[key] = value;
      }
    }
    return merged;
  }
}

function readEntries(key: string): PluginUiEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(readStored(key) ?? 'null');
    return Array.isArray(parsed) ? (parsed as PluginUiEntry[]) : null;
  } catch {
    return null;
  }
}
