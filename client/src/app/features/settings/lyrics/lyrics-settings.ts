import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  CdkDrag,
  CdkDragHandle,
  CdkDragPlaceholder,
  CdkDropList,
  moveItemInArray,
} from '@angular/cdk/drag-drop';
import { LucideArrowDown, LucideArrowUp, LucideGripVertical } from '@lucide/angular';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { TvService } from '../../../core/services/tv.service';
import { DropListSettleDirective } from '../../../shared/directives/drop-list-settle.directive';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';

const KEYS = {
  order: 'lyrics.provider_order',
  disabled: 'lyrics.disabled_providers',
  sidecars: 'lyrics.sidecars',
  writeBack: 'lyrics.write_back',
  autoFetch: 'lyrics.auto_fetch',
};

export function listOf(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** A stored JSON array of strings as editable text, one entry per `sep`. */
export function listText(raw: string | null | undefined, sep: string): string {
  return listOf(raw).join(sep);
}

/** `shown` in the stored order; the namespaces it does not name follow, in registration order. */
export function ranked(shown: string[], stored: string[]): string[] {
  const rank = (n: string) => (stored.includes(n) ? stored.indexOf(n) : Number.MAX_SAFE_INTEGER);
  return shown.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map((x) => x.n);
}

interface Row {
  namespace: string;
  name: string;
}

export function listJson(text: string, split: RegExp): string {
  return JSON.stringify(
    text
      .split(split)
      .map((s) => s.trim().replace(/^\./, ''))
      .filter(Boolean),
  );
}

@Component({
  selector: 'app-lyrics-settings',
  imports: [
    FormsModule,
    TranslatePipe,
    ToggleFieldComponent,
    CdkDropList,
    DropListSettleDirective,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    LucideGripVertical,
    LucideArrowUp,
    LucideArrowDown,
  ],
  templateUrl: './lyrics-settings.html',
})
export class LyricsSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly registry = inject(PluginUiRegistryService);
  readonly tv = inject(TvService);

  readonly loading = signal(true);
  readonly saving = signal(false);

  readonly autoFetch = signal(true);
  readonly writeBack = signal(false);
  readonly sidecars = signal('');
  /** The stored order, kept whole so a namespace whose plugin is not installed keeps its slot. */
  private readonly order = signal<string[]>([]);
  readonly disabled = signal<ReadonlySet<string>>(new Set());

  private readonly names = computed(() => {
    const out = new Map<string, string>();
    for (const e of this.registry.pluginEntries()) {
      if (e.provider?.lyrics) for (const n of e.provider.namespaces) out.set(n, e.name ?? e.pluginId);
    }
    return out;
  });
  readonly rows = computed<Row[]>(() =>
    ranked([...this.names().keys()], this.order()).map((namespace) => ({
      namespace,
      name: this.names().get(namespace)!,
    })),
  );

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.autoFetch.set(map[KEYS.autoFetch] !== 'false');
      this.writeBack.set(map[KEYS.writeBack] === 'true');
      this.order.set(listOf(map[KEYS.order]));
      this.disabled.set(new Set(listOf(map[KEYS.disabled])));
      this.sidecars.set(listText(map[KEYS.sidecars], ', '));
    } catch {
      this.toast.error(this.translate.instant('settings.lyrics.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  reorder(from: number, to: number) {
    const shown = this.rows().map((r) => r.namespace);
    if (from === to || to < 0 || to >= shown.length) return;
    moveItemInArray(shown, from, to);
    const set = new Set(shown);
    const base = [...this.order(), ...shown.filter((n) => !this.order().includes(n))];
    this.order.set(base.map((n) => (set.has(n) ? shown.shift()! : n)));
  }

  toggle(namespace: string, on: boolean) {
    const next = new Set(this.disabled());
    if (on) next.delete(namespace);
    else next.add(namespace);
    this.disabled.set(next);
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        [KEYS.autoFetch]: String(this.autoFetch()),
        [KEYS.writeBack]: String(this.writeBack()),
        [KEYS.order]: JSON.stringify(this.order()),
        [KEYS.disabled]: JSON.stringify([...this.disabled()]),
        [KEYS.sidecars]: listJson(this.sidecars(), /[,\s]+/),
      });
      this.toast.success(this.translate.instant('settings.lyrics.saved'));
    } catch {
      // handled by global interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
