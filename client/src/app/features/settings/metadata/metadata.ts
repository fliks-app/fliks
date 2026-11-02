import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';

const KINDS = ['movie', 'series', 'book', 'comic', 'album'] as const;
const DEFAULT_ORDER: Record<string, string[]> = {
  movie: ['tmdb', 'tvdb'],
  series: ['tmdb', 'tvdb'],
  book: ['openlibrary', 'bnf', 'googlebooks', 'audible', 'audnexus'],
};
const orderKey = (kind: string) => `metadata.provider_order.${kind}`;

interface Row {
  namespace: string;
  pluginId: string;
  name: string;
}

/** Provider order per kind and the namespaces each provider plugin serves. */
@Component({
  selector: 'app-metadata-settings',
  imports: [RouterLink, TranslatePipe],
  templateUrl: './metadata.html',
})
export class MetadataSettingsComponent implements OnInit {
  private readonly registry = inject(PluginUiRegistryService);
  private readonly settings = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly kinds = KINDS;
  readonly loading = signal(true);
  private readonly stored = signal<Record<string, string[]>>({});
  readonly providers = computed(() =>
    this.registry
      .pluginEntries()
      .filter((e) => e.provider)
      .map((e) => ({
        pluginId: e.pluginId,
        name: e.name ?? e.pluginId,
        namespaces: e.provider!.namespaces,
        kinds: e.provider!.kinds,
      })),
  );

  async ngOnInit(): Promise<void> {
    try {
      const all = await this.settings.getAll();
      const out: Record<string, string[]> = {};
      for (const kind of KINDS) out[kind] = parseOrder(all[orderKey(kind)]);
      this.stored.set(out);
    } catch {
      this.toast.error(this.translate.instant('settings.metadata.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  private order(kind: string): string[] {
    const stored = this.stored()[kind];
    return stored?.length ? stored : (DEFAULT_ORDER[kind] ?? []);
  }

  /** Stored order first, then the providers it does not name. */
  rows(kind: string): Row[] {
    const all: Row[] = this.providers()
      .filter((p) => p.kinds.includes(kind))
      .flatMap((p) => p.namespaces.map((namespace) => ({ namespace, pluginId: p.pluginId, name: p.name })));
    const rank = (r: Row) => {
      const i = this.order(kind).indexOf(r.namespace);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return all
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
      .map((x) => x.r);
  }

  async move(kind: string, index: number, by: -1 | 1): Promise<void> {
    const names = this.rows(kind).map((r) => r.namespace);
    const j = index + by;
    if (j < 0 || j >= names.length) return;
    [names[index], names[j]] = [names[j], names[index]];
    // Slots of namespaces whose plugin is not installed keep their place.
    const shown = new Set(names);
    const base = [...this.order(kind), ...names.filter((n) => !this.order(kind).includes(n))];
    const next = [...names];
    const merged = base.map((n) => (shown.has(n) ? next.shift()! : n));
    try {
      await this.settings.set(orderKey(kind), JSON.stringify(merged));
      this.stored.update((s) => ({ ...s, [kind]: merged }));
    } catch {
      this.toast.error(this.translate.instant('settings.metadata.save_error'));
    }
  }

  configLink(pluginId: string): string[] {
    const page = this.registry.pluginEntries().find((e) => e.pluginId === pluginId)?.configPages?.[0];
    return page ? ['/admin/settings/plugins', pluginId, page.id] : [];
  }
}

function parseOrder(raw: string | null | undefined): string[] {
  try {
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
