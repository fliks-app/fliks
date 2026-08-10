import {
  Component,
  ChangeDetectionStrategy,
  DestroyRef,
  ElementRef,
  computed,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideSnowflake, LucideX } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  IndexersApiService,
  IndexerRow,
} from '../../../core/services/api/indexers-api.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { ToastService } from '../../../core/services/toast.service';

@Component({
  selector: 'app-indexers-settings',
  imports: [FormsModule, LucideSnowflake, LucideX, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './indexers.html',
})
export class IndexersSettingsComponent implements OnInit {
  private readonly api = inject(IndexersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly toast = inject(ToastService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');

  readonly rows = signal<IndexerRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);

  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formPriority = signal(25);
  readonly formRequestDelay = signal(2);
  readonly formEnabled = signal(true);
  readonly formEnableSearch = signal(true);
  readonly formTorznabBase = signal('');
  readonly formTorznabKey = signal('');
  readonly formMinSeeders = signal(0);
  readonly formSeedRatio = signal(1);
  readonly formMaxRetentionDays = signal<number | null>(null);
  readonly formUnknownLanguage = signal('');

  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly statsLoading = signal(false);
  readonly statsData = signal<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>([]);
  readonly statsIndexerName = signal('');
  readonly languages = signal<{ id: number; name: string; isoCode: string }[]>([]);

  // ── Cooldowns ──
  private readonly cooldownDialog =
    viewChild<ElementRef<HTMLDialogElement>>('cooldownDialog');
  /** Ticks so countdowns tick down and expired windows drop without a refetch. */
  private readonly now = signal(Date.now());
  readonly cooldownRow = signal<IndexerRow | null>(null);
  readonly resettingCooldown = signal(false);

  /** Rows whose window is still open, recomputed against the local clock. */
  readonly cooledDown = computed(() => {
    const now = this.now();
    return this.rows().filter(
      (ix) => ix.cooldown && Date.parse(ix.cooldown.until) > now,
    );
  });
  readonly hasCooldowns = computed(() => this.cooledDown().length > 0);

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 5_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  isCooledDown(ix: IndexerRow): boolean {
    return !!ix.cooldown && Date.parse(ix.cooldown.until) > this.now();
  }

  /** Remaining window as `1 h 05 min`, `4 min 12 s`, `38 s`. */
  cooldownRemaining(ix: IndexerRow): string {
    if (!ix.cooldown) return '';
    const total = Math.max(
      0,
      Math.round((Date.parse(ix.cooldown.until) - this.now()) / 1000),
    );
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
  }

  cooldownExpiresAt(ix: IndexerRow): string {
    return ix.cooldown ? new Date(ix.cooldown.until).toLocaleTimeString() : '';
  }

  openCooldown(ix: IndexerRow) {
    this.cooldownRow.set(ix);
    this.cooldownDialog()?.nativeElement.showModal();
  }

  closeCooldown() {
    this.cooldownDialog()?.nativeElement.close();
  }

  async resetCooldown(ix: IndexerRow) {
    this.resettingCooldown.set(true);
    try {
      await this.api.clearCooldown(ix.id);
      this.closeCooldown();
      await this.reloadAll();
      this.toast.success(
        this.translate.instant('settings.indexers.cooldown_reset_done', {
          name: ix.name,
        }),
      );
    } catch {
      // handled by global error interceptor
    } finally {
      this.resettingCooldown.set(false);
    }
  }

  async resetAllCooldowns() {
    this.resettingCooldown.set(true);
    try {
      const { cleared } = await this.api.clearAllCooldowns();
      await this.reloadAll();
      this.toast.success(
        this.translate.instant('settings.indexers.cooldown_reset_all_done', {
          count: cleared,
        }),
      );
    } catch {
      // handled by global error interceptor
    } finally {
      this.resettingCooldown.set(false);
    }
  }

  ngOnInit() {
    this.reloadAll();
  }

  async reloadAll() {
    this.loading.set(true);
    this.listError.set('');
    try {
      const [list, langs] = await Promise.all([
        this.api.list(),
        this.profilesApi.getLanguageDefinitions(),
      ]);
      this.rows.set(list);
      this.languages.set(langs);
    } catch {
      this.listError.set(
        this.translate.instant('settings.indexers.load_error'),
      );
    } finally {
      this.loading.set(false);
    }
  }

  openCreate() {
    this.editingId.set(null);
    this.formName.set('');
    this.formPriority.set(25);
    this.formRequestDelay.set(2);
    this.formEnabled.set(true);
    this.formEnableSearch.set(true);
    this.formTorznabBase.set('');
    this.formTorznabKey.set('');
    this.formMinSeeders.set(0);
    this.formSeedRatio.set(1);
    this.formMaxRetentionDays.set(null);
    this.formUnknownLanguage.set('');
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(ix: IndexerRow) {
    this.editingId.set(ix.id);
    this.formName.set(ix.name);
    this.formPriority.set(ix.priority);
    this.formRequestDelay.set(ix.requestDelay ?? 2);
    this.formEnabled.set(ix.enabled);
    this.formEnableSearch.set(ix.enableSearch);
    const s = ix.settings ?? {};
    this.formTorznabBase.set(String(s['baseUrl'] ?? ''));
    this.formTorznabKey.set('');
    this.formMinSeeders.set(Number(s['minSeeders'] ?? 0));
    this.formSeedRatio.set(Number(s['seedRatio'] ?? 1));
    this.formMaxRetentionDays.set(s['maxRetentionDays'] != null ? Number(s['maxRetentionDays']) : null);
    this.formUnknownLanguage.set(String(s['unknownLanguageIsoCode'] ?? ''));
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor() {
    this.editorDialog()?.nativeElement.close();
  }

  async testConnection() {
    this.testResult.set(null);
    const base = this.formTorznabBase().trim();
    if (!base) {
      this.testResult.set({
        ok: false,
        message: this.translate.instant('settings.indexers.base_url_required'),
      });
      return;
    }
    this.testLoading.set(true);
    try {
      const r = await this.api.testConnection({
        implementation: 'torznab',
        settings: {
          baseUrl: base.replace(/\/$/, ''),
          apiKey: this.formTorznabKey().trim(),
        },
      });
      this.testResult.set(r);
    } catch {
      this.testResult.set({
        ok: false,
        message: this.translate.instant('settings.indexers.test_network_error'),
      });
    } finally {
      this.testLoading.set(false);
    }
  }

  async save() {
    const name = this.formName().trim();
    if (!name) return;
    const base = this.formTorznabBase().trim();
    if (!base) return;

    const body = {
      name,
      implementation: 'torznab' as const,
      priority: this.formPriority(),
      requestDelay: this.formRequestDelay(),
      enabled: this.formEnabled(),
      enableSearch: this.formEnableSearch(),
      settings: {
        baseUrl: base.replace(/\/$/, ''),
        apiKey: this.formTorznabKey().trim() || undefined,
        minSeeders: this.formMinSeeders(),
        seedRatio: this.formSeedRatio(),
        maxRetentionDays: this.formMaxRetentionDays() || undefined,
        unknownLanguageIsoCode: this.formUnknownLanguage() || undefined,
      },
    };

    this.saving.set(true);
    const id = this.editingId();
    try {
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch {
      // handled by global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async openStats(ix: IndexerRow) {
    this.statsIndexerName.set(ix.name);
    this.statsLoading.set(true);
    this.statsDialog()?.nativeElement.showModal();
    try {
      const data = await this.api.getStats(ix.id);
      this.statsData.set(data);
    } finally {
      this.statsLoading.set(false);
    }
  }

  closeStats() {
    this.statsDialog()?.nativeElement.close();
  }

  async deleteRow(ix: IndexerRow) {
    const msg = this.translate.instant('settings.indexers.confirm_delete', {
      name: ix.name,
    });
    if (!await this.confirmation.confirm({ title: this.translate.instant('common.confirm'), message: msg, variant: 'danger' })) return;
    try {
      await this.api.remove(ix.id);
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string } };
      void this.confirmation.alert({
        title: this.translate.instant('common.error'),
        message: httpErr.error?.message ??
          this.translate.instant('settings.indexers.delete_error'),
        variant: 'danger',
      });
    }
  }
}
