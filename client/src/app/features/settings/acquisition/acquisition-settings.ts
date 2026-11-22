import { LoadFailedComponent } from '../../../shared/components/load-failed/load-failed';
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
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TvService } from '../../../core/services/tv.service';
import { DropListSettleDirective } from '../../../shared/directives/drop-list-settle.directive';
import { listOf, ranked } from '../lyrics/lyrics-settings';

/** `visible` in its new order, placed in the slots `stored` gives the visible ids; an id that is not shown (a provider that is down) keeps its place. */
export function placeVisible(stored: string[], visible: string[]): string[] {
  const shown = new Set(visible);
  const queue = [...visible];
  const out = stored.map((id) => (shown.has(id) ? queue.shift()! : id));
  return [...out, ...queue];
}

const KEYS = { order: 'acquisition.providerOrder', interval: 'acquisition.sweepInterval', unrequested: 'music.unrequested_tracks' };

export type UnrequestedTracks = 'import_unmonitored' | 'skip';

@Component({
  selector: 'app-acquisition-settings',
  imports: [
    LoadFailedComponent, TranslatePipe,
    FormsModule,
    CdkDropList,
    DropListSettleDirective,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    LucideGripVertical,
    LucideArrowUp,
    LucideArrowDown,
  ],
  templateUrl: './acquisition-settings.html',
})
export class AcquisitionSettingsComponent implements OnInit {
  private readonly api = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly registry = inject(PluginUiRegistryService);
  readonly tv = inject(TvService);

  readonly loading = signal(true);
  readonly loadFailed = signal(false);
  readonly saving = signal(false);
  readonly interval = signal('360');
  readonly unrequested = signal<UnrequestedTracks>('import_unmonitored');
  private readonly order = signal<string[]>([]);

  /** Installed providers in the stored order; a provider the order does not name follows by id. */
  readonly rows = computed(() => {
    const names = new Map(this.registry.providers().map((p) => [p.pluginId, p.name]));
    const ids = [...names.keys()].sort();
    return ranked(ids, this.order()).map((id) => ({ id, name: names.get(id)! }));
  });

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const map = await this.api.getAll(true);
      this.order.set(listOf(map[KEYS.order]));
      this.interval.set(map[KEYS.interval] ?? '360');
      this.unrequested.set(map[KEYS.unrequested] === 'skip' ? 'skip' : 'import_unmonitored');
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  reorder(from: number, to: number) {
    const ids = this.rows().map((r) => r.id);
    if (from === to || to < 0 || to >= ids.length) return;
    moveItemInArray(ids, from, to);
    this.order.set(placeVisible(this.order(), ids));
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        [KEYS.order]: JSON.stringify(placeVisible(this.order(), this.rows().map((r) => r.id))),
        [KEYS.interval]: String(this.interval()),
        [KEYS.unrequested]: this.unrequested(),
      });
      this.toast.success(this.translate.instant('settings.acquisition.saved'));
    } catch {
      // handled by global interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
