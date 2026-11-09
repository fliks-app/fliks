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

const KEYS = { order: 'acquisition.providerOrder', interval: 'acquisition.sweepInterval' };

@Component({
  selector: 'app-acquisition-settings',
  imports: [
    TranslatePipe,
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
  readonly saving = signal(false);
  readonly interval = signal('360');
  private readonly order = signal<string[]>([]);

  /** Installed providers in the stored order; a provider the order does not name follows by id. */
  readonly rows = computed(() => {
    const names = new Map(this.registry.providers().map((p) => [p.pluginId, p.name]));
    const ids = [...names.keys()].sort();
    return ranked(ids, this.order()).map((id) => ({ id, name: names.get(id)! }));
  });

  async ngOnInit() {
    try {
      const map = await this.api.getAll();
      this.order.set(listOf(map[KEYS.order]));
      this.interval.set(map[KEYS.interval] ?? '360');
    } catch {
      this.toast.error(this.translate.instant('settings.acquisition.load_error'));
    } finally {
      this.loading.set(false);
    }
  }

  reorder(from: number, to: number) {
    const ids = this.rows().map((r) => r.id);
    if (from === to || to < 0 || to >= ids.length) return;
    moveItemInArray(ids, from, to);
    this.order.set(ids);
  }

  async save() {
    this.saving.set(true);
    try {
      await this.api.setBulk({
        [KEYS.order]: JSON.stringify(this.rows().map((r) => r.id)),
        [KEYS.interval]: String(this.interval()),
      });
      this.toast.success(this.translate.instant('settings.acquisition.saved'));
    } catch {
      // handled by global interceptor
    } finally {
      this.saving.set(false);
    }
  }
}
