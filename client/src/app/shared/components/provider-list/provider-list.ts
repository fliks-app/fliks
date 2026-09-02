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
import { HttpClient, HttpContext } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideArrowUp, LucideArrowDown, LucideRotateCcw, LucideSearch } from '@lucide/angular';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { SKIP_ERROR_TOAST } from '../../../core/interceptors/error.interceptor';
import { ToastService } from '../../../core/services/toast.service';
import { InputFieldComponent } from '../forms/input-field/input-field';
import { ToggleFieldComponent } from '../forms/toggle-field/toggle-field';
import { SelectFieldComponent } from '../forms/select-field/select-field';
import { FieldDef, SECRETS_SET_KEY } from '@fliks/plugin-contract/ui';
import { SchemaFormComponent, SchemaFormValue } from '../schema-form/schema-form';
import {
  ProviderDraft,
  ProviderImplementation,
  ProviderInstance,
  ProviderCooldown,
  ProviderListAction,
  ProviderListLabels,
  ProviderRowAction,
  ProviderTestResult,
} from './provider-list.types';
import { DataTableComponent } from '../data-table/data-table';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

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
    ModalFooterComponent,
    ModalHeaderComponent,
    TranslateModule,
    NgTemplateOutlet,
    InputFieldComponent,
    ToggleFieldComponent,
    SelectFieldComponent,
    SchemaFormComponent,
    DataTableComponent,
    LucideArrowUp,
    LucideArrowDown,
    LucideRotateCcw,
    LucideSearch,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './provider-list.html',
})
export class ProviderListComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  readonly togglingId = signal<number | null>(null);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly bulkDialog = viewChild<ElementRef<HTMLDialogElement>>('bulkDialog');
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
  /** Adds the selection column and the bulk actions acting on it. Off by default: a list edited
   *  one row at a time should not grow a column asking to be ticked. */
  readonly bulkSelect = input(false);
  /** Rendered once above the rows (`ProvidersConfigPage.actions[].scope: 'list'`), distinct from per-row actions. */
  readonly listActions = input<readonly ProviderListAction[]>([]);
  /** Rendered per row (`ProvidersConfigPage.actions[].scope: 'row'`) — every entry gets its own button. */
  readonly rowActions = input<readonly ProviderRowAction[]>([]);
  /** The action that clears a row's cooldown, rendered beside the cooldown itself rather than
   *  as another button in the actions cell. Routed through `runRowAction`, so it keeps that
   *  path's confirmation, busy state and reload. */
  readonly cooldownAction = input<ProviderRowAction | null>(null);
  /** Matches subtitle-providers' current UX: renaming the draft to the driver's label while creating. */
  readonly autoFillNameFromImplementation = input(false);
  /** Runs against the unsaved draft (before create/update), catching a bad connection before it's saved. */
  readonly testConnection = input<((draft: ProviderDraft) => Promise<ProviderTestResult>) | null>(
    null,
  );
  /** Last chance to normalise the save body (e.g. trim a URL) without resurrecting a dropped secret. */
  readonly beforeSave = input<((body: Record<string, unknown>) => Record<string, unknown>) | null>(
    null,
  );
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

  /** Ids ticked in the selection column. Pruned on every reload: a row someone else deleted must
   *  not stay selected and be acted on by the next bulk call. */
  readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  readonly bulkBusy = signal(false);
  /** Field keys the bulk editor will write. Everything unticked is left as each row has it. */
  readonly bulkApply = signal<ReadonlySet<string>>(new Set());
  readonly bulkValue = signal<SchemaFormValue>({});
  readonly bulkPriority = signal(0);

  /** Free-text filter on the row name, and the display order chosen over the server's own.
   *  Both live in the same bar the bulk actions take over, so selecting a row moves nothing. */
  readonly filterText = signal('');
  readonly sortBy = signal<'default' | 'name'>('default');

  readonly listActionBusy = signal<string | null>(null);
  readonly rowActionBusy = signal<string | null>(null);

  /** The open `GET` row action's declared table. Null keeps `<app-data-table>` out of the
   *  DOM, so it only fetches when a row asked for it. */
  readonly resultView = signal<RowActionResultView | null>(null);

  /** A `GET` with no declared `result` has nothing to show, so it gets no button — the same
   *  fail-closed rule the `table` kind applies to an unknown `actionId`. */
  readonly visibleRowActions = computed(() =>
    this.rowActions().filter((a) => a.method !== 'GET' || !!a.result),
  );

  /** Display order: priority ascending when `reorderable`, otherwise the server's own order. */
  readonly orderedRows = computed(() =>
    this.reorderable() ? [...this.rows()].sort((a, b) => a.priority - b.priority) : this.rows(),
  );

  /**
   * What the table renders: the display order, then the name filter, then the chosen sort.
   *
   * `moveRow` deliberately keeps reading `orderedRows`: the swap it performs is over the real
   * priority order, and a filtered or renamed-sorted view would swap the wrong pair.
   */
  readonly visibleRows = computed(() => {
    const needle = this.filterText().trim().toLowerCase();
    const rows = needle
      ? this.orderedRows().filter((r) => r.name.toLowerCase().includes(needle))
      : this.orderedRows();
    if (this.sortBy() !== 'name') return rows;
    return [...rows].sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly selectedRows = computed(() => {
    const ids = this.selectedIds();
    return this.rows().filter((r) => ids.has(r.id));
  });

  /** Over the rows on screen, not the whole list: with a filter applied, ticking the header box
   *  must mean "these", which is also what makes it usable as "select the eight matching X". */
  readonly allSelected = computed(() => {
    const rows = this.visibleRows();
    const ids = this.selectedIds();
    return rows.length > 0 && rows.every((r) => ids.has(r.id));
  });

  /** The one implementation every selected row shares, or null when they differ: the bulk editor
   *  is built from an implementation's own fields, so a mixed selection has no form to render. */
  readonly bulkImplementation = computed(() => {
    const rows = this.selectedRows();
    if (rows.length === 0) return null;
    const key = this.implementationKey();
    const first = String(rows[0]![key] ?? '');
    if (rows.some((r) => String(r[key] ?? '') !== first)) return null;
    return this.implementations().find((i) => i.implementation === first) ?? null;
  });

  /**
   * Fields the bulk editor offers: the implementation's tuning knobs, plus priority when the page
   * has one. What identifies one instance is left out, because the same value written to every
   * selected row is meaningless or destructive there: a `url` is the row (twelve indexers pointed
   * at one tracker), and a credential belongs to whatever that url is.
   */
  readonly bulkFields = computed<readonly FieldDef[]>(
    () =>
      this.bulkImplementation()
        ?.fields.filter((f): f is FieldDef => !('kind' in f) || f.kind === 'field')
        .filter((f) => !f.secret && f.type !== 'url') ?? [],
  );

  readonly currentImplementation = computed(
    () =>
      this.implementations().find((i) => i.implementation === this.draftImplementation()) ?? null,
  );

  readonly requiredFieldMissing = computed(() => {
    const impl = this.currentImplementation();
    if (!impl) return false;
    const value = this.draftValue();
    return impl.fields.some((f) => {
      if (!f.required || f.secret) return false;
      const v = value[f.key];
      return Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim();
    });
  });

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    this.listError.set('');
    try {
      const rows = await firstValueFrom(this.http.get<ProviderInstance[]>(this.listUrl()));
      this.rows.set(rows);
      const live = new Set(rows.map((r) => r.id));
      this.selectedIds.update((ids) => new Set([...ids].filter((id) => live.has(id))));
      this.changed.emit();
    } catch {
      this.listError.set(this.translate.instant(this.labels().loadErrorKey));
    } finally {
      this.loading.set(false);
    }
  }

  implementationLabel(value: string): string {
    const impl = this.implementations().find((i) => i.implementation === value);
    return impl
      ? this.translate.instant(impl.labelKey)
      : this.translate.instant('provider_list.unknown_implementation');
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
      if (f.type === 'multiselect') {
        // A new row starts from the declared default; an existing one from what it stored.
        const fallback = Array.isArray(f.default) ? [...f.default] : [];
        value[f.key] = Array.isArray(raw) ? raw : fallback;
        continue;
      }
      value[f.key] = (raw ?? f.default ?? '') as string | number | boolean;
    }
    return value;
  }

  openCreate(): void {
    this.editingId.set(null);
    const impl = this.implementations()[0] ?? null;
    this.draftImplementation.set(impl?.implementation ?? '');
    this.draftName.set(
      impl && this.autoFillNameFromImplementation() ? this.translate.instant(impl.labelKey) : '',
    );
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
    const set = (row.settings as Record<string, unknown> | undefined)?.[SECRETS_SET_KEY];
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
      this.testResult.set({
        ok: false,
        message: this.translate.instant('provider_list.test_network_error'),
      });
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
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: msg,
        variant: 'danger',
      }))
    )
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

  /** Whether this row is at one end of the real priority order. Read from the row rather than
   *  from the loop index, which now counts a filtered, possibly re-sorted view. */
  isFirstInOrder(row: ProviderInstance): boolean {
    return this.orderedRows()[0]?.id === row.id;
  }

  isLastInOrder(row: ProviderInstance): boolean {
    const ordered = this.orderedRows();
    return ordered[ordered.length - 1]?.id === row.id;
  }

  /** Swaps this row's priority with its neighbour in display order and persists both. */
  async moveRow(row: ProviderInstance, direction: -1 | 1): Promise<void> {
    const ordered = this.orderedRows();
    const idx = ordered.findIndex((r) => r.id === row.id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= ordered.length) return;
    const other = ordered[swapIdx];
    try {
      await firstValueFrom(
        this.http.put(`${this.listUrl()}/${row.id}`, { ...row, priority: other.priority }),
      );
      await firstValueFrom(
        this.http.put(`${this.listUrl()}/${other.id}`, { ...other, priority: row.priority }),
      );
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

  /** The implementation column earns its place only when there is something to tell apart —
   *  the editor already hides its selector on a single implementation for the same reason. */
  readonly showImplementation = computed(() => this.implementations().length > 1);

  /** The column appears for resources that track backoff at all, so a healthy list still shows
   *  the column its rows can report into rather than the table reshaping on the first failure. */
  readonly showCooldown = computed(
    () => this.cooldownAction() !== null || this.rows().some((r) => r.cooldown !== undefined),
  );

  cooldownOf(row: ProviderInstance): ProviderCooldown | null {
    return row.cooldown ?? null;
  }

  /** Coarse on purpose: a backoff of hours read to the second would be noise, and the value is
   *  a snapshot the list does not tick. */
  cooldownRemaining(cd: ProviderCooldown): string {
    const minutes = Math.ceil(cd.remainingMs / 60_000);
    if (minutes < 60) return this.translate.instant('provider_list.cooldown_minutes', { minutes });
    return this.translate.instant('provider_list.cooldown_hours', {
      hours: Math.ceil(minutes / 60),
    });
  }

  cooldownReasonKey(cd: ProviderCooldown): string {
    return cd.reason === 'rate-limit'
      ? 'provider_list.cooldown_rate_limit'
      : 'provider_list.cooldown_failures';
  }

  /** Persists the whole row, as `moveRow` does: the resource merges secrets on update, so
   *  echoing a redacted settings bag back never overwrites the stored one. */
  async toggleEnabled(row: ProviderInstance): Promise<void> {
    this.togglingId.set(row.id);
    try {
      await firstValueFrom(
        this.http.put(`${this.listUrl()}/${row.id}`, { ...row, enabled: !row.enabled }),
      );
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }

  toggleSelected(id: number): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** The header box: ticks or unticks the rows on screen, leaving any selection the filter hides
   *  alone. The bulk bar always states the real count, so nothing acts on more than it claims. */
  toggleAllSelected(): void {
    const visible = this.visibleRows().map((r) => r.id);
    const all = this.allSelected();
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      for (const id of visible) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  clearSelection(): void {
    this.selectedIds.set(new Set());
  }

  /**
   * Runs one request per selected row, sequentially, and reports once. Sequential on purpose: a
   * dozen parallel writes against a plugin's own database buy nothing and turn one slow row into
   * a burst the far end may rate-limit. Each request suppresses the global error toast so the
   * summary is the only thing the user reads, and the loop never stops early: the rows that can
   * be written are written.
   */
  private async runOverSelection(
    call: (row: ProviderInstance) => Promise<unknown>,
    okKey: string,
  ): Promise<void> {
    const rows = this.selectedRows();
    if (rows.length === 0) return;
    this.bulkBusy.set(true);
    let failed = 0;
    try {
      for (const row of rows) {
        try {
          await call(row);
        } catch {
          failed++;
        }
      }
      await this.reload();
      if (failed === 0) {
        this.toast.success(this.translate.instant(okKey, { count: rows.length }));
        this.clearSelection();
      } else {
        this.toast.error(
          this.translate.instant('bulk.partial', {
            done: rows.length - failed,
            failed,
          }),
        );
      }
    } finally {
      this.bulkBusy.set(false);
    }
  }

  /** Bulk writes report as a batch, so their failures must not each raise their own toast. */
  private silent(): { context: HttpContext } {
    return { context: new HttpContext().set(SKIP_ERROR_TOAST, true) };
  }

  /** Persists the whole row with `enabled` forced, the convention `toggleEnabled` already uses. */
  async bulkSetEnabled(enabled: boolean): Promise<void> {
    await this.runOverSelection(
      (row) =>
        firstValueFrom(this.http.put(`${this.listUrl()}/${row.id}`, { ...row, enabled }, this.silent())),
      enabled ? 'provider_list.bulk_enabled_done' : 'provider_list.bulk_disabled_done',
    );
  }

  async bulkDelete(): Promise<void> {
    const count = this.selectedIds().size;
    if (count === 0) return;
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('provider_list.bulk_delete_confirm', { count }),
      variant: 'danger',
    });
    if (!ok) return;
    await this.runOverSelection(
      (row) => firstValueFrom(this.http.delete(`${this.listUrl()}/${row.id}`, this.silent())),
      'provider_list.bulk_deleted_done',
    );
  }

  openBulkEditor(): void {
    const impl = this.bulkImplementation();
    if (!impl) return;
    this.bulkApply.set(new Set());
    // Seeded from the first selected row so a ticked field starts on a real value rather than
    // blank; nothing is written until its own box is ticked.
    this.bulkValue.set(this.seedValue(this.selectedRows()[0] ?? null, impl));
    this.bulkPriority.set(this.selectedRows()[0]?.priority ?? this.defaultPriority());
    this.bulkDialog()?.nativeElement.showModal();
  }

  closeBulkEditor(): void {
    this.bulkDialog()?.nativeElement.close();
  }

  isBulkApplied(key: string): boolean {
    return this.bulkApply().has(key);
  }

  toggleBulkApply(key: string): void {
    this.bulkApply.update((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  readonly bulkNothingApplied = computed(() => this.bulkApply().size === 0);

  /**
   * Applies only the ticked fields to every selected row. Each row is persisted whole, with its
   * own settings spread under the changes: a field nobody ticked keeps whatever that row had,
   * which is the difference between a bulk edit and twelve identical rows.
   */
  async saveBulkEdit(): Promise<void> {
    const applied = this.bulkApply();
    if (applied.size === 0) return;
    const value = this.bulkValue();
    const settings: Record<string, unknown> = {};
    const topLevel: Record<string, unknown> = {};
    for (const field of this.bulkFields()) {
      if (!applied.has(field.key)) continue;
      (field.topLevel ? topLevel : settings)[field.key] = value[field.key];
    }
    const priority = applied.has('priority') ? this.bulkPriority() : null;

    this.closeBulkEditor();
    await this.runOverSelection(
      (row) =>
        firstValueFrom(
          this.http.put(
            `${this.listUrl()}/${row.id}`,
            {
              ...row,
              ...topLevel,
              ...(priority === null ? {} : { priority }),
              settings: { ...(row.settings ?? {}), ...settings },
            },
            this.silent(),
          ),
        ),
      'bulk.done',
    );
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
      this.resultView.set({
        url,
        title: `${row.name} — ${this.translate.instant(action.labelKey)}`,
        result: action.result,
      });
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
