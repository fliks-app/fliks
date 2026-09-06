import { ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideTriangleAlert } from '@lucide/angular';
import { PluginUiRegistryService } from '../../core/plugin-ui/plugin-ui-registry.service';
import { evaluateWhen } from '../../core/plugin-ui/when-evaluator';
import { AuthService } from '../../core/services/auth.service';
import { TvService } from '../../core/services/tv.service';
import { DeviceService } from '../../core/services/device.service';
import { SettingsApiService } from '../../core/services/api/settings-api.service';
import { ToastService } from '../../core/services/toast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { SchemaFormComponent, SchemaFormValue } from '../../shared/components/schema-form/schema-form';
import { ProviderListComponent } from '../../shared/components/provider-list/provider-list';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderListAction,
  ProviderListLabels,
  ProviderRowAction,
  ProviderTestResult,
} from '../../shared/components/provider-list/provider-list.types';
import { DataTableComponent } from '../../shared/components/data-table/data-table';
import type { ListAction, RowAction, TableRow } from '../../shared/components/data-table/data-table.types';
import {
  FORM_ACTION_IDS,
  TABLE_ROW_ACTION_IDS,
  type FieldDef,
  type FormActionId,
  type FormConfigPage,
  type FormItem,
  type TableRowActionId,
} from '@fliks/plugin-contract/ui';

/** A manifest is untrusted JSON, so the declared union has to be re-checked at runtime. */
function isTableRowActionId(value: string): value is TableRowActionId {
  return (TABLE_ROW_ACTION_IDS as readonly string[]).includes(value);
}
import { AnyConfigPage, ProvidersView, TableView, isFormView, isProvidersView, isTableView } from './view-kinds.types';

type UnavailableReason = 'unknown_plugin' | 'unknown_view';

/** A plugin's own `testConnection` wire shape — `messageKey` names an entry in its manifest
 *  `i18n` dict, `detail` the dynamic half (an HTTP status, its own error text). */
interface PluginTestConnectionResponse {
  ok: boolean;
  messageKey: string;
  detail?: string;
}

/**
 * `app_settings` stores every value as text, and the form model is typed: a `toggle` handed the
 * string "false" renders checked, and a `number` handed "60" is a string in a numeric field.
 * An unset number stays empty rather than becoming 0 — that is what "no cleanup" means.
 */
/** A `status` item has no `fields`/`kind: 'group'` of its own to recurse into — only a bare
 *  field or a group's own fields are operator-editable settings. */
function flattenFields(items: readonly FormItem[]): FieldDef[] {
  const out: FieldDef[] = [];
  for (const item of items) {
    if (item.kind === 'group') out.push(...item.fields);
    else if (item.kind === undefined || item.kind === 'field') out.push(item);
  }
  return out;
}

function statusSettingKeys(items: readonly FormItem[]): string[] {
  return items.filter((item) => item.kind === 'status').map((item) => item.settingKey);
}

function typedSetting(field: FieldDef, raw: string | null | undefined): string | number | boolean {
  if (field.type === 'toggle') {
    return raw === undefined || raw === null || raw === '' ? Boolean(field.default) : raw === 'true';
  }
  if (field.type === 'number') {
    const source = raw !== undefined && raw !== null && raw !== '' ? raw : field.default;
    if (source === undefined || source === null || source === '') return '';
    const n = Number(source);
    return Number.isFinite(n) ? n : '';
  }
  return raw ?? (field.default != null ? String(field.default) : '');
}

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
  imports: [TranslatePipe, LucideTriangleAlert, SchemaFormComponent, ProviderListComponent, DataTableComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plugin-view.html',
})
export class PluginViewComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly registry = inject(PluginUiRegistryService);
  private readonly http = inject(HttpClient);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);

  // Angular reuses this component across param changes on the same route
  // config (same wildcard path, different pluginId/view) — read reactively.
  private readonly params = toSignal(this.route.paramMap);

  readonly pluginId = computed(() => this.params()?.get('pluginId') ?? '');
  readonly view = computed(() => this.params()?.get('view') ?? '');

  readonly page = computed<AnyConfigPage | undefined>(() => this.registry.configPage(this.pluginId(), this.view()));

  /**
   * A plugin route is resolved at runtime, so it carries no `data.titleKey` for
   * the layout to read and the navbar fell back to the app name. The page's own
   * label is the title, set here and cleared on the way out — the convention
   * {@link NavbarService} documents for routes that name themselves.
   */
  private readonly navbar = inject(NavbarService);
  private readonly pageTitleEffect = effect(() => {
    const key = this.page()?.labelKey;
    this.navbar.setPageTitle(key ? this.translate.instant(key) : '');
  });

  ngOnDestroy(): void {
    this.navbar.clearPageTitle();
  }

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
  readonly formActionBusy = signal<string | null>(null);

  // --- `providers` kind: the driver list is itself a proxied route ---
  readonly resolvedImplementations = signal<ProviderImplementation[] | null>(null);
  /** A failed fetch still resolves to `[]` (so the renderer mounts), but that's
   *  indistinguishable from a real driver with no fields — flag it separately. */
  readonly implementationsLoadError = signal(false);

  constructor() {
    effect(() => {
      const p = this.page();
      if (p && isFormView(p)) void this.loadFormValue(p.fields);
    });
    effect(() => {
      const p = this.page();
      if (p && isProvidersView(p)) void this.loadImplementations(p.implementations);
    });
  }

  private async loadFormValue(items: readonly FormItem[]): Promise<void> {
    this.formLoading.set(true);
    try {
      const all = await this.settingsApi.getAll();
      const prefix = `plugin.${this.pluginId()}.`;
      const value: SchemaFormValue = {};
      for (const field of flattenFields(items)) value[field.key] = typedSetting(field, all[prefix + field.key]);
      // Read-only: whatever the plugin last wrote via `config.set`, keyed by its own settingKey.
      for (const key of statusSettingKeys(items)) value[key] = all[prefix + key] ?? '';
      this.formValue.set(value);
    } finally {
      this.formLoading.set(false);
    }
  }

  /** An unknown id renders nothing: a `data` plugin cannot ship code, so core is the only
   *  thing that can act. `FormActionId` is the whole catalogue. */
  formActions(page: FormConfigPage): { id: string; labelKey: string; actionId: FormActionId }[] {
    return (page.actions ?? []).filter((a) => (FORM_ACTION_IDS as readonly string[]).includes(a.actionId));
  }

  async runFormAction(action: { id: string; labelKey: string; actionId: FormActionId }): Promise<void> {
    this.formActionBusy.set(action.id);
    try {
      const res = await firstValueFrom(
        this.http.post<{ configured: boolean; delivered: number; failures: string[] }>(
          `/api/plugins/${this.pluginId()}/events/test`,
          {},
        ),
      );
      if (!res.configured) this.toast.warning(this.translate.instant('plugin_view.webhook_test_unconfigured'));
      else if (res.failures.length) {
        this.toast.error(this.translate.instant('plugin_view.webhook_test_failed', { detail: res.failures.join('; ') }));
      } else {
        this.toast.success(this.translate.instant('plugin_view.webhook_test_ok', { count: res.delivered }));
      }
    } catch {
      // surfaced by the global error interceptor
    } finally {
      this.formActionBusy.set(null);
    }
  }

  async saveForm(): Promise<void> {
    this.formSaving.set(true);
    try {
      const editableKeys = new Set(flattenFields(this.formPage()?.fields ?? []).map((f) => f.key));
      const prefix = `plugin.${this.pluginId()}.`;
      const patch: Record<string, string> = {};
      // A `status` key is loaded into the same value bag for display, but the plugin owns
      // it — writing it back here would race whatever it writes via `config.set`.
      for (const [k, v] of Object.entries(this.formValue())) {
        // `null` is the value bag's erase marker; these settings are text, so it stores as blank.
        if (editableKeys.has(k)) patch[prefix + k] = v === null ? '' : String(v);
      }
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

  /** Tests the unsaved draft — `ProvidersConfigPage.testConnection`, distinct from
   *  `actions[]`: there is no row yet, so no `:id` to substitute. */
  providerTestConnection(view: ProvidersView): ((draft: ProviderDraft) => Promise<ProviderTestResult>) | null {
    const test = view.testConnection;
    if (!test) return null;
    return async (draft: ProviderDraft) => {
      try {
        const res = await firstValueFrom(
          this.http.post<PluginTestConnectionResponse>(this.resourceUrl(test.route), draft),
        );
        return { ok: res.ok, message: this.resolvePluginMessage(res.messageKey, res.detail) };
      } catch {
        return { ok: false, message: this.translate.instant('provider_list.test_network_error') };
      }
    };
  }

  /** `messageKey` names an entry in the plugin's own manifest `i18n` dict — merged into the
   *  active language by `PluginI18nService` at boot, so it resolves the same way a `labelKey`
   *  does. A miss (a manifest/plugin-code mismatch) falls back rather than printing the raw key. */
  private resolvePluginMessage(messageKey: string, detail?: string): string {
    const resolved = this.translate.instant(messageKey);
    const base = resolved === messageKey ? this.translate.instant('provider_list.test_unknown_result') : resolved;
    return detail ? `${base} — ${detail}` : base;
  }

  /** `actions[].scope: 'row'` — every entry renders its own button. `route` is only
   *  host-prefixed here; substituting the row's `:id` is `ProviderListComponent`'s job,
   *  since only it holds the row. */
  providerRowActions(view: ProvidersView): ProviderRowAction[] {
    return (view.actions ?? [])
      .filter((a) => a.scope === 'row' && a.slot !== 'cooldown-reset')
      .map((a) => this.toProviderRowAction(a));
  }

  /** The cooldown reset renders beside the cooldown instead of as another button, so it is
   *  pulled out of `providerRowActions` rather than rendered twice. */
  providerCooldownAction(view: ProvidersView): ProviderRowAction | null {
    const action = (view.actions ?? []).find((a) => a.scope === 'row' && a.slot === 'cooldown-reset');
    return action ? this.toProviderRowAction(action) : null;
  }

  private toProviderRowAction(a: NonNullable<ProvidersView['actions']>[number]): ProviderRowAction {
    return {
      labelKey: a.labelKey,
      method: a.method,
      route: this.resourceUrl(a.route),
      confirmKey: a.confirmKey,
      result: a.result,
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

  /**
   * Only `kind: 'proxy'` carries a plugin-relative path — `route`/`action` resolve in-app.
   *
   * `when` is evaluated here rather than in `<app-data-table>`: it reads the viewer, and a
   * generic table has no business knowing about permissions. The row-scoped `visibleWhen`
   * rides through untouched — only the table holds a row.
   */
  tableRowActions(view: TableView): RowAction[] {
    const ctx = {
      isAdmin: this.auth.user()?.isAdmin ?? false,
      hasPermission: (p: string) => this.auth.hasPermission(p),
      isTv: this.tv.isTv(),
      isTouch: this.device.isTouch(),
    };
    return (view.rowActions ?? [])
      .filter((a) => evaluateWhen(a.when, ctx))
      .map((a) => (a.kind === 'proxy' ? { ...a, path: this.resourceUrl(a.path) } : a));
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
      ...(l?.createTitleKey ? { createTitleKey: l.createTitleKey } : {}),
      ...(l?.editTitleKey ? { editTitleKey: l.editTitleKey } : {}),
    };
  }

  /** Resolves a `TableRowActionId` against its row — today only jumping to that row's own media
   *  page via its `mediaId`/`mediaType` columns; anything else renders no button.
   *
   *  A row naming an episode lands on that episode rather than on the series root: a queue row
   *  is read to reach the thing it is downloading, and a series page does not say which. */
  tableResolveAction = (actionId: string, row: TableRow): (() => void) | undefined => {
    if (!isTableRowActionId(actionId)) return undefined;
    const id = row['mediaId'];
    const type = row['mediaType'];
    // Both columns or no button: guessing the type sends a series to a movie page.
    if (id == null || (type !== 'series' && type !== 'movie')) return undefined;
    const episodeId = row['episodeId'];
    const url =
      type === 'series'
        ? episodeId == null
          ? `/series/${id}`
          : `/series/${id}/episode/${episodeId}`
        : `/movies/${id}`;
    return () => {
      void this.router.navigateByUrl(url);
    };
  };
}
