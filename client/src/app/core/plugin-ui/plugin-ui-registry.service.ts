import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';
import type { ConfigPage, ReleasePickerRoutes, SlotId, UiContribution } from './contribution.types';
import type { PluginUiEntry } from './plugin-ui-response';

/** Bounds the boot-blocking wait: a dead plugin endpoint must never hold the splash. */
const FETCH_TIMEOUT_MS = 3000;

/**
 * Fetches `GET /api/plugins/ui` once at app init and caches it. Every other
 * consumer reads the cache — nothing here ever refetches. On any error,
 * timeout or malformed payload it fails open to an empty registry, so a
 * Fliks with no plugins and one with a broken plugin endpoint boot identically.
 */
@Injectable({ providedIn: 'root' })
export class PluginUiRegistryService {
  private readonly http = inject(HttpClient);
  /** A signal, so a reload after an install or a toggle re-runs every consumer's `computed`
   *  instead of waiting for the next full page load. */
  private readonly entriesSignal = signal<PluginUiEntry[]>([]);

  async load(): Promise<void> {
    const entries = await firstValueFrom(
      this.http.get<PluginUiEntry[]>('/api/plugins/ui').pipe(
        timeout(FETCH_TIMEOUT_MS),
        catchError(() => of<PluginUiEntry[]>([])),
      ),
    );
    this.entriesSignal.set(Array.isArray(entries) ? entries : []);
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

  /** The plugin declaring `ui.releasePicker`, or null when none is installed. The backend
   *  refuses a second declaration, so at most one entry ever has it — the first is it. */
  releasePicker(): { pluginId: string; routes: ReleasePickerRoutes } | null {
    const entry = this.entries.find((e) => e.releasePicker);
    return entry?.releasePicker ? { pluginId: entry.pluginId, routes: entry.releasePicker } : null;
  }

  /**
   * Every plugin's `i18n[lang]` dict combined; undefined when none ship that locale.
   * Ordered by plugin id and first-declared wins, so one plugin can never redefine
   * another's key — and the winner does not change when install order does.
   */
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
