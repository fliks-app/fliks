import { Component, OnInit, inject, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import type {
  IssuedWorkerToken,
  OptimizeWorker,
  PathMapping,
  WorkerPathAccess,
  WorkerToken,
} from '../../../core/models/optimize';
import { EnabledSwitchComponent } from '../../../shared/components/enabled-switch';
import { InputFieldComponent } from '../../../shared/components/forms/input-field/input-field';
import { SelectFieldComponent } from '../../../shared/components/forms/select-field/select-field';

/** The editable part of a token: saved with its own button. */
interface Draft {
  access: WorkerPathAccess;
  mappings: PathMapping[];
}

@Component({
  selector: 'app-optimize-workers',
  imports: [TranslatePipe, EnabledSwitchComponent, InputFieldComponent, SelectFieldComponent],
  templateUrl: './optimize-workers.html',
})
export class OptimizeWorkersComponent implements OnInit {
  private readonly api = inject(OptimizeService);
  private readonly settings = inject(SettingsApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);

  readonly loading = signal(true);
  readonly tokens = signal<WorkerToken[]>([]);
  readonly workers = signal<OptimizeWorker[]>([]);
  readonly drafts = signal<Record<number, Draft>>({});
  readonly busy = signal<number | null>(null);
  readonly newName = signal('');
  readonly creating = signal(false);
  readonly issued = signal<IssuedWorkerToken | null>(null);
  readonly publicUrlSet = signal(true);
  readonly origin = window.location.origin;
  readonly helpUrl = 'https://github.com/fliks-app/fliks/blob/main/docs/optimize-workers.md';

  async ngOnInit() {
    await this.load();
    this.loading.set(false);
  }

  private async load(saved?: number) {
    try {
      const [tokens, workers] = await Promise.all([this.api.workerTokens(), this.api.workers()]);
      this.tokens.set(tokens);
      this.workers.set(workers);
      const old = this.drafts();
      this.drafts.set(
        Object.fromEntries(
          tokens.map((t) => [
            t.id,
            // An unsaved edit survives the reload that another action triggers.
            t.id !== saved && old[t.id] && this.differs(old[t.id], t)
              ? old[t.id]
              : { access: t.pathAccess, mappings: t.pathMappings.map((m) => ({ ...m })) },
          ]),
        ),
      );
      this.publicUrlSet.set(!!(await this.settings.getAll())['public_url']);
    } catch {
      // The global interceptor toasts the reason.
    }
  }

  draft(t: WorkerToken): Draft {
    return this.drafts()[t.id] ?? { access: t.pathAccess, mappings: [] };
  }

  private edit(t: WorkerToken, fn: (d: Draft) => Draft) {
    this.drafts.update((all) => ({ ...all, [t.id]: fn(this.draft(t)) }));
  }

  setAccess(t: WorkerToken, access: string) {
    this.edit(t, (d) => ({ ...d, access: access as WorkerPathAccess }));
  }

  addMapping(t: WorkerToken) {
    this.edit(t, (d) => ({ ...d, mappings: [...d.mappings, { from: '', to: '' }] }));
  }

  setMapping(t: WorkerToken, i: number, key: keyof PathMapping, value: string) {
    this.edit(t, (d) => ({
      ...d,
      mappings: d.mappings.map((m, j) => (j === i ? { ...m, [key]: value } : m)),
    }));
  }

  removeMapping(t: WorkerToken, i: number) {
    this.edit(t, (d) => ({ ...d, mappings: d.mappings.filter((_, j) => j !== i) }));
  }

  private differs(d: Draft, t: WorkerToken): boolean {
    return (
      d.access !== t.pathAccess || JSON.stringify(d.mappings) !== JSON.stringify(t.pathMappings)
    );
  }

  dirty(t: WorkerToken): boolean {
    return this.differs(this.draft(t), t);
  }

  async create() {
    const name = this.newName().trim();
    if (!name) return;
    this.creating.set(true);
    try {
      this.issued.set(await this.api.createWorkerToken(name));
      this.newName.set('');
      await this.load();
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.creating.set(false);
    }
  }

  async copyIssued() {
    const token = this.issued()?.token;
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      this.toast.success(this.translate.instant('common.copied'));
    } catch {
      // Plain-http origins have no clipboard: the token stays selectable on screen.
    }
  }

  async toggle(t: WorkerToken) {
    await this.patch(t, { enabled: !t.enabled });
  }

  async save(t: WorkerToken) {
    const d = this.draft(t);
    const mappings = d.access === 'shared' ? d.mappings : [];
    if (mappings.some((m) => !m.from.trim() || !m.to.trim())) {
      this.toast.error(this.translate.instant('settings.optimize.workers.mapping_invalid'));
      return;
    }
    await this.patch(t, { pathAccess: d.access, pathMappings: mappings }, true);
  }

  private async patch(
    t: WorkerToken,
    body: Parameters<OptimizeService['patchWorkerToken']>[1],
    reset = false,
  ) {
    this.busy.set(t.id);
    try {
      await this.api.patchWorkerToken(t.id, body);
      await this.load(reset ? t.id : undefined);
    } catch {
      // The global interceptor toasts the reason.
    } finally {
      this.busy.set(null);
    }
  }

  async revoke(t: WorkerToken) {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('settings.optimize.workers.confirm_revoke', { name: t.name }),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.revokeWorkerToken(t.id);
      await this.load();
    } catch {
      // The global interceptor toasts the reason.
    }
  }

  /** The name of the token behind a connected instance, or the local engine. */
  ownerOf(w: OptimizeWorker): string {
    if (w.tokenId == null) return this.translate.instant('settings.optimize.workers.local');
    return this.tokens().find((t) => t.id === w.tokenId)?.name ?? `#${w.tokenId}`;
  }

  seen(iso: string | null): string {
    return iso
      ? new Date(iso).toLocaleString(this.translate.currentLang() || undefined)
      : this.translate.instant('settings.optimize.workers.never');
  }
}
