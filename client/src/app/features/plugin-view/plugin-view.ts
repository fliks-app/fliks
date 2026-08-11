import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideTriangleAlert } from '@lucide/angular';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { SettingsApiService } from '../../core/services/api/settings-api.service';
import { SchemaFormComponent, SchemaFormValue } from '../../shared/components/schema-form/schema-form';
import { ProviderListComponent } from '../../shared/components/provider-list/provider-list';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderListAction,
  ProviderListLabels,
  ProviderTestResult,
} from '../../shared/components/provider-list/provider-list.types';
import { DataTableComponent } from '../../shared/components/data-table/data-table';
import type { ListAction, RowAction, TableRow } from '../../shared/components/data-table/data-table.types';
import type { FormConfigPage } from '../../core/plugin-ui/contribution.types';
import { AnyConfigPage, ProvidersView, TableView, isFormView, isProvidersView, isTableView } from './view-kinds.types';

type UnavailableReason = 'unknown_plugin' | 'unknown_view';

/** Generic chrome for a real plugin's `providers` page — the plugin owns only field/implementation labelKeys. */
const PLUGIN_PROVIDER_LABELS: ProviderListLabels = {
  newLabelKey: 'provider_list.new',
  colNameKey: 'provider_list.col_name',
  colImplementationKey: 'provider_list.col_implementation',
  colPriorityKey: 'provider_list.col_priority',
  colEnabledKey: 'provider_list.col_enabled',
  actionsKey: 'common.actions',
  editKey: 'common.edit',
  deleteKey: 'common.delete',
  saveKey: 'common.save',
  cancelKey: 'common.cancel',
  createTitleKey: 'provider_list.create_title',
  editTitleKey: 'provider_list.edit_title',
  fieldNameKey: 'provider_list.field_name',
  fieldImplementationKey: 'provider_list.field_implementation',
  fieldPriorityKey: 'provider_list.field_priority',
  fieldEnabledKey: 'provider_list.field_enabled',
  emptyKey: 'provider_list.empty',
  loadErrorKey: 'provider_list.load_error',
  confirmDeleteKey: 'provider_list.confirm_delete',
  deleteErrorKey: 'provider_list.delete_error',
  testConnectionKey: 'provider_list.test_connection',
};

/**
 * Resolves `plugins/:pluginId/:view` to a declared `ConfigPage` and renders
 * it with the matching renderer for its `kind` — `form` when absent.
 */
@Component({
  selector: 'app-plugin-view',
  imports: [TranslateModule, LucideTriangleAlert, SchemaFormComponent, ProviderListComponent, DataTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-view.html',
})
export class PluginViewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly http = inject(HttpClient);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);

  // Angular reuses this component across param changes on the same route
  // config (same wildcard path, different pluginId/view) — read reactively.
  private readonly params = toSignal(this.route.paramMap);

  readonly pluginId = computed(() => this.params()?.get('pluginId') ?? '');
  readonly view = computed(() => this.params()?.get('view') ?? '');

  readonly page = computed<AnyConfigPage | undefined>(() => this.registry.configPage(this.pluginId(), this.view()));

  readonly reason = computed<UnavailableReason | null>(() => {
    if (!this.registry.hasPlugin(this.pluginId())) return 'unknown_plugin';
    if (!this.page()) return 'unknown_view';
    return null;
  });

  readonly providersView = computed<ProvidersView | null>(() => {
    const p = this.page();
    return p && isProvidersView(p) ? p : null;
  });

  readonly tableView = computed<TableView | null>(() => {
    const p = this.page();
    return p && isTableView(p) ? p : null;
  });

  readonly formPage = computed<FormConfigPage | null>(() => {
    const p = this.page();
    return p && isFormView(p) ? p : null;
  });

  // --- `form` kind: pure key/value settings under `plugin.<id>.` ---
  readonly formValue = signal<SchemaFormValue>({});
  readonly formLoading = signal(true);
  readonly formSaving = signal(false);

  // --- `providers` kind: the driver list is itself a proxied route ---
  readonly resolvedImplementations = signal<ProviderImplementation[] | null>(null);
  /** A failed fetch still resolves to `[]` (so the renderer mounts), but that's
   *  indistinguishable from a real driver with no fields — flag it separately. */
  readonly implementationsLoadError = signal(false);

  constructor() {
    effect(() => {
      const p = this.page();
      if (p && isFormView(p)) void this.loadFormValue(p.fields.map((f) => [f.key, f.default] as const));
    });
    effect(() => {
      const p = this.page();
      if (p && isProvidersView(p)) void this.loadImplementations(p.implementations);
    });
  }

  private async loadFormValue(defaults: readonly (readonly [string, unknown])[]): Promise<void> {
    this.formLoading.set(true);
    try {
      const all = await this.settingsApi.getAll();
      const prefix = `plugin.${this.pluginId()}.`;
      const value: SchemaFormValue = {};
      for (const [key, def] of defaults) {
        const raw = all[prefix + key];
        value[key] = (raw ?? def ?? '') as string | number | boolean;
      }
      this.formValue.set(value);
    } finally {
      this.formLoading.set(false);
    }
  }

  async saveForm(): Promise<void> {
    this.formSaving.set(true);
    try {
      const prefix = `plugin.${this.pluginId()}.`;
      const patch: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.formValue())) patch[prefix + k] = String(v);
      await this.settingsApi.setBulk(patch);
    } finally {
      this.formSaving.set(false);
    }
  }

  /** A manifest declares routes relative to itself — only the proxy at
   *  `/api/plugins/<id>/` actually serves them. */
  resourceUrl(path: string): string {
    return `/api/plugins/${this.pluginId()}${path}`;
  }

  private async loadImplementations(route: string): Promise<void> {
    this.resolvedImplementations.set(null);
    this.implementationsLoadError.set(false);
    try {
      this.resolvedImplementations.set(
        await firstValueFrom(this.http.get<ProviderImplementation[]>(this.resourceUrl(route))),
      );
    } catch {
      // An empty list here is indistinguishable from "no fields to show" — surface it instead.
      this.resolvedImplementations.set([]);
      this.implementationsLoadError.set(true);
    }
  }

  /** The plan's motivating row action — a proxied route, run against the unsaved draft.
   *  Only the first `scope: 'row'` entry is wired; additional ones are dropped. */
  providerTestConnection(view: ProvidersView): ((draft: ProviderDraft) => Promise<ProviderTestResult>) | null {
    const action = view.actions?.find((a) => a.scope === 'row');
    if (!action) return null;
    return async (draft: ProviderDraft) => {
      try {
        return await firstValueFrom(
          this.http.request<ProviderTestResult>(action.method, this.resourceUrl(action.route), { body: draft }),
        );
      } catch {
        return { ok: false, message: this.translate.instant('provider_list.test_network_error') };
      }
    };
  }

  /** `actions[].scope: 'list'` — rendered once above the rows, run with no draft. */
  providerListActions(view: ProvidersView): ProviderListAction[] {
    return (view.actions ?? [])
      .filter((a) => a.scope === 'list')
      .map((a) => ({
        labelKey: a.labelKey,
        run: async () => {
          await firstValueFrom(this.http.request(a.method, this.resourceUrl(a.route), { body: {} }));
        },
      }));
  }

  /** Only `kind: 'proxy'` carries a plugin-relative path — `route`/`action` resolve in-app. */
  tableRowActions(view: TableView): RowAction[] {
    return (view.rowActions ?? []).map((a) => (a.kind === 'proxy' ? { ...a, path: this.resourceUrl(a.path) } : a));
  }

  tableListActions(view: TableView): ListAction[] {
    return (view.listActions ?? []).map((a) => ({ ...a, path: this.resourceUrl(a.path) }));
  }

  /** Merges a page's own wording over the generic provider-list chrome. */
  providerLabels(view: ProvidersView): ProviderListLabels {
    const l = view.labels;
    return {
      ...PLUGIN_PROVIDER_LABELS,
      ...(l?.newKey ? { newLabelKey: l.newKey } : {}),
      ...(l?.emptyKey ? { emptyKey: l.emptyKey } : {}),
      ...(l?.testKey ? { testConnectionKey: l.testKey } : {}),
      ...(l?.deleteConfirmKey ? { confirmDeleteKey: l.deleteConfirmKey } : {}),
    };
  }

  /** Closed catalogue of `table` row actionIds core resolves — today just jumping to a row's
   *  own media page via its `mediaId`/`mediaType` columns; anything else renders no button. */
  tableResolveAction = (actionId: string, row: TableRow): (() => void) | undefined => {
    if (actionId !== 'table.open-media') return undefined;
    const id = row['mediaId'];
    const type = row['mediaType'];
    // Both columns or no button: guessing the type sends a series to a movie page.
    if (id == null || (type !== 'series' && type !== 'movie')) return undefined;
    const base = type === 'series' ? '/series' : '/movies';
    return () => {
      void this.router.navigateByUrl(`${base}/${id}`);
    };
  };
}
