import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnInit,
  TemplateRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideArrowUp, LucideArrowDown } from '@lucide/angular';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { InputFieldComponent } from '../forms/input-field/input-field';
import { ToggleFieldComponent } from '../forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { SchemaFormComponent, SchemaFormValue } from '../schema-form/schema-form';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderInstance,
  ProviderListAction,
  ProviderListLabels,
  ProviderRowAction,
  ProviderTestResult,
} from './provider-list.types';
import { DataTableComponent } from '../data-table/data-table';

interface RowActionResultView {
  url: string;
  title: string;
  result: NonNullable<ProviderRowAction['result']>;
}

/** Substitutes a row action route's `:id` with the row's own id — null (never a request) when
 *  there was no `:id` to substitute, or any `:token` placeholder survives that, so a mistyped
 *  or list-scope route can never fire with a literal placeholder still in its path. */
export function resolveRowActionRoute(route: string, id: number | string): string | null {
  if (!route.includes(':id')) return null;
  const resolved = route.replace(':id', String(id));
  return /:[A-Za-z_]/.test(resolved) ? null : resolved;
}

/**
 * The `providers` view kind from the plugin plan: a CRUD list of instances,
 * each edited by `<app-schema-form>` built from the driver's own fields.
 * `listUrl` is the only route the component knows — CRUD is plain REST
 * (`GET/POST listUrl`, `PUT/DELETE listUrl/:id`) and it never interprets
 * `settings`, so it stays ignorant of whatever protocol a driver speaks.
 */
@Component({
  selector: 'app-provider-list',
  imports: [
    TranslateModule,
    NgTemplateOutlet,
    InputFieldComponent,
    ToggleFieldComponent,
    SelectFieldComponent,
    SchemaFormComponent,
    DataTableComponent,
    LucideArrowUp,
    LucideArrowDown,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './provider-list.html',
})
export class ProviderListComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly resultDialog = viewChild<ElementRef<HTMLDialogElement>>('resultDialog');

  /** Empty renders no heading — a plugin page carries its own page-level title. */
  readonly titleKey = input('');
  readonly listUrl = input.required<string>();
  readonly implementations = input.required<readonly ProviderImplementation[]>();
  /** The wire field naming the implementation — `type` for subtitle providers, `implementation` elsewhere. */
  readonly implementationKey = input('implementation');
  readonly labels = input.required<ProviderListLabels>();
  /** A page that never exposed priority must not start offering it as an editable field. */
  readonly showPriority = input(true);
  readonly defaultPriority = input(0);
  readonly defaultEnabled = input(true);
  /** Sorts rows by priority and adds move-up/down swaps — priority is meaningless to reorder otherwise. */
  readonly reorderable = input(false);
  /** Rendered once above the rows (`ProvidersConfigPage.actions[].scope: 'list'`), distinct from per-row actions. */
  readonly listActions = input<readonly ProviderListAction[]>([]);
  /** Rendered per row (`ProvidersConfigPage.actions[].scope: 'row'`) — every entry gets its own button. */
  readonly rowActions = input<readonly ProviderRowAction[]>([]);
  /** Matches subtitle-providers' current UX: renaming the draft to the driver's label while creating. */
  readonly autoFillNameFromImplementation = input(false);
  /** Runs against the unsaved draft (before create/update), catching a bad connection before it's saved. */
  readonly testConnection = input<((draft: ProviderDraft) => Promise<ProviderTestResult>) | null>(null);
  /** Last chance to normalise the save body (e.g. trim a URL) without resurrecting a dropped secret. */
  readonly beforeSave = input<((body: Record<string, unknown>) => Record<string, unknown>) | null>(null);
  /** Extra per-row column/actions the generic shape can't express (e.g. subtitle providers' rate-limit badge). */
  readonly rowExtraStatus = input<TemplateRef<{ $implicit: ProviderInstance }> | null>(null);
  readonly rowExtraActions = input<TemplateRef<{ $implicit: ProviderInstance }> | null>(null);
  /** Fires after every successful (re)load — the hook for a host's own data that tracks the row set (e.g. rate limits). */
  readonly changed = output<void>();

  readonly rows = signal<ProviderInstance[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);
  readonly draftName = signal('');
  readonly draftPriority = signal(0);
  readonly draftEnabled = signal(true);
  readonly draftImplementation = signal('');
  readonly draftValue = signal<SchemaFormValue>({});
  /** Which credentials the row already stores, straight from the redacted response. */
  readonly secretsSet = signal<readonly string[]>([]);

  readonly testLoading = signal(false);
  readonly testResult = signal<ProviderTestResult | null>(null);

  readonly listActionBusy = signal<string | null>(null);
  readonly rowActionBusy = signal<string | null>(null);

  /** The open `GET` row action's declared table. Null keeps `<app-data-table>` out of the
   *  DOM, so it only fetches when a row asked for it. */
  readonly resultView = signal<RowActionResultView | null>(null);

  /** A `GET` with no declared `result` has nothing to show, so it gets no button — the same
   *  fail-closed rule the `table` kind applies to an unknown `actionId`. */
  readonly visibleRowActions = computed(() => this.rowActions().filter((a) => a.method !== 'GET' || !!a.result));

  /** Display order: priority ascending when `reorderable`, otherwise the server's own order. */
  readonly orderedRows = computed(() =>
    this.reorderable() ? [...this.rows()].sort((a, b) => a.priority - b.priority) : this.rows(),
  );

  readonly currentImplementation = computed(
    () => this.implementations().find((i) => i.implementation === this.draftImplementation()) ?? null,
  );

  readonly requiredFieldMissing = computed(() => {
    const impl = this.currentImplementation();
    if (!impl) return false;
    const value = this.draftValue();
    return impl.fields.some((f) => f.required && !f.secret && !String(value[f.key] ?? '').trim());
  });

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      this.rows.set(await firstValueFrom(this.http.get<ProviderInstance[]>(this.listUrl())));
      this.changed.emit();
    } catch {
      this.listError.set(this.translate.instant(this.labels().loadErrorKey));
    } finally {
      this.loading.set(false);
    }
  }

  implementationLabel(value: string): string {
    const impl = this.implementations().find((i) => i.implementation === value);
    return impl ? this.translate.instant(impl.labelKey) : this.translate.instant('provider_list.unknown_implementation');
  }

  private seedValue(row: ProviderInstance | null, impl: ProviderImplementation): SchemaFormValue {
    const value: SchemaFormValue = {};
    for (const f of impl.fields) {
      if (f.secret) {
        value[f.key] = '';
        continue;
      }
      const source = f.topLevel ? row : (row?.settings as Record<string, unknown> | undefined);
      const raw = source ? source[f.key] : undefined;
      value[f.key] = (raw ?? f.default ?? '') as string | number | boolean;
    }
    return value;
  }

  openCreate(): void {
    this.editingId.set(null);
    const impl = this.implementations()[0] ?? null;
    this.draftImplementation.set(impl?.implementation ?? '');
    this.draftName.set(impl && this.autoFillNameFromImplementation() ? this.translate.instant(impl.labelKey) : '');
    this.draftPriority.set(this.defaultPriority());
    this.draftEnabled.set(this.defaultEnabled());
    this.draftValue.set(impl ? this.seedValue(null, impl) : {});
    this.secretsSet.set([]);
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(row: ProviderInstance): void {
    this.editingId.set(row.id);
    this.draftName.set(row.name);
    this.draftPriority.set(row.priority);
    this.draftEnabled.set(row.enabled);
    const implValue = String(row[this.implementationKey()] ?? '');
    this.draftImplementation.set(implValue);
    const impl = this.currentImplementation();
    this.draftValue.set(impl ? this.seedValue(row, impl) : {});
    this.secretsSet.set(this.storedSecrets(row));
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  private storedSecrets(row: ProviderInstance): readonly string[] {
    const set = (row.settings as Record<string, unknown> | undefined)?.['secretsSet'];
    return Array.isArray(set) ? set.map(String) : [];
  }

  onImplementationChange(value: string): void {
    this.draftImplementation.set(value);
    const impl = this.currentImplementation();
    if (impl && this.autoFillNameFromImplementation() && this.editingId() === null) {
      this.draftName.set(this.translate.instant(impl.labelKey));
    }
  }

  closeEditor(): void {
    this.editorDialog()?.nativeElement.close();
  }

  private splitDraft(): { settings: Record<string, unknown>; topLevel: Record<string, unknown> } {
    const impl = this.currentImplementation();
    const value = this.draftValue();
    const settings: Record<string, unknown> = {};
    const topLevel: Record<string, unknown> = {};
    for (const f of impl?.fields ?? []) {
      const v = value[f.key];
      if (v === undefined) continue;
      (f.topLevel ? topLevel : settings)[f.key] = v;
    }
    return { settings, topLevel };
  }

  /** Blank means "leave the stored secret alone" — never round-trip it as ''. Applied to the
   *  test draft as well as the save body, so testing an edit doesn't demand the key again. */
  private withoutBlankSecrets(settings: Record<string, unknown>): Record<string, unknown> {
    const out = { ...settings };
    for (const f of this.currentImplementation()?.fields ?? []) {
      if (f.secret && out[f.key] === '') delete out[f.key];
    }
    return out;
  }

  async runTestConnection(): Promise<void> {
    const run = this.testConnection();
    if (!run) return;
    this.testResult.set(null);
    this.testLoading.set(true);
    try {
      const { settings } = this.splitDraft();
      const id = this.editingId();
      this.testResult.set(
        await run({
          implementation: this.draftImplementation(),
          settings: this.withoutBlankSecrets(settings),
          ...(id == null ? {} : { id }),
        }),
      );
    } catch {
      this.testResult.set({ ok: false, message: this.translate.instant('provider_list.test_network_error') });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save(): Promise<void> {
    const name = this.draftName().trim();
    if (!name || this.requiredFieldMissing()) return;

    const { settings, topLevel } = this.splitDraft();
    let body: Record<string, unknown> = {
      name,
      [this.implementationKey()]: this.draftImplementation(),
      priority: this.draftPriority(),
      enabled: this.draftEnabled(),
      ...topLevel,
      settings: this.withoutBlankSecrets(settings),
    };
    const transform = this.beforeSave();
    if (transform) body = transform(body);

    this.saving.set(true);
    const id = this.editingId();
    try {
      if (id == null) await firstValueFrom(this.http.post(this.listUrl(), body));
      else await firstValueFrom(this.http.put(`${this.listUrl()}/${id}`, body));
      this.closeEditor();
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async deleteRow(row: ProviderInstance): Promise<void> {
    const l = this.labels();
    const msg = this.translate.instant(l.confirmDeleteKey, { name: row.name });
    if (!(await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })))
      return;
    try {
      await firstValueFrom(this.http.delete(`${this.listUrl()}/${row.id}`));
      await this.reload();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ?? this.translate.instant(l.deleteErrorKey),
        variant: 'danger',
      });
    }
  }

  /** Swaps this row's priority with its neighbour in display order and persists both. */
  async moveRow(row: ProviderInstance, direction: -1 | 1): Promise<void> {
    const ordered = this.orderedRows();
    const idx = ordered.findIndex((r) => r.id === row.id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
    const other = ordered[swapIdx];
    try {
      await firstValueFrom(this.http.put(`${this.listUrl()}/${row.id}`, { ...row, priority: other.priority }));
      await firstValueFrom(this.http.put(`${this.listUrl()}/${other.id}`, { ...other, priority: row.priority }));
      await this.reload();
    } catch {
      // handled by the global error interceptor
    }
  }

  async runListAction(action: ProviderListAction): Promise<void> {
    this.listActionBusy.set(action.labelKey);
    try {
      await action.run();
      await this.reload();
    } finally {
      this.listActionBusy.set(null);
    }
  }

  rowActionKey(row: ProviderInstance, action: ProviderRowAction): string {
    return `${row.id}:${action.labelKey}`;
  }

  /** A `GET` opens its declared table, which fetches the route itself; a mutation just
   *  reloads the rows. Never fires when the row's `:id` can't be substituted. */
  async runRowAction(row: ProviderInstance, action: ProviderRowAction): Promise<void> {
    const url = resolveRowActionRoute(action.route, row.id);
    if (!url) return;
    if (action.confirmKey) {
      const ok = await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant(action.confirmKey),
        variant: 'danger',
      });
      if (!ok) return;
    }
    if (action.method === 'GET') {
      if (!action.result) return;
      this.resultView.set({ url, title: `${row.name} — ${this.translate.instant(action.labelKey)}`, result: action.result });
      this.resultDialog()?.nativeElement.showModal();
      return;
    }
    this.rowActionBusy.set(this.rowActionKey(row, action));
    try {
      await firstValueFrom(this.http.request(action.method, url));
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.rowActionBusy.set(null);
    }
  }

  closeResult(): void {
    this.resultDialog()?.nativeElement.close();
    this.resultView.set(null);
  }
}
