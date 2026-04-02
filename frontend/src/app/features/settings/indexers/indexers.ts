import {
  Component,
  ChangeDetectionStrategy,
  ElementRef,
  signal,
  inject,
  OnInit,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  IndexersApiService,
  IndexerRow,
} from '../../../core/services/api/indexers-api.service';
import { ProfilesService } from '../../../core/services/api/profiles.service';

@Component({
  selector: 'app-indexers-settings',
  imports: [FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './indexers.html',
})
export class IndexersSettingsComponent implements OnInit {
  private readonly api = inject(IndexersApiService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly translate = inject(TranslateService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');
  private readonly statsDialog = viewChild<ElementRef<HTMLDialogElement>>('statsDialog');

  readonly rows = signal<IndexerRow[]>([]);
  readonly loading = signal(true);
  readonly listError = signal('');
  readonly saving = signal(false);
  readonly saveError = signal('');
  readonly editingId = signal<number | null>(null);

  readonly formName = signal('');
  readonly formPriority = signal(25);
  readonly formEnabled = signal(true);
  readonly formEnableSearch = signal(true);
  readonly formTorznabBase = signal('');
  readonly formTorznabKey = signal('');
  readonly formMinSeeders = signal(0);
  readonly formUnknownLanguage = signal('');

  readonly testLoading = signal(false);
  readonly testResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly statsLoading = signal(false);
  readonly statsData = signal<{ date: string; queries: number; avgResponseMs: number; totalResults: number; errors: number }[]>([]);
  readonly statsIndexerName = signal('');
  readonly languages = signal<{ id: number; name: string; isoCode: string }[]>([]);

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
    this.formEnabled.set(true);
    this.formEnableSearch.set(true);
    this.formTorznabBase.set('');
    this.formTorznabKey.set('');
    this.formMinSeeders.set(0);
    this.formUnknownLanguage.set('');
    this.saveError.set('');
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(ix: IndexerRow) {
    this.editingId.set(ix.id);
    this.formName.set(ix.name);
    this.formPriority.set(ix.priority);
    this.formEnabled.set(ix.enabled);
    this.formEnableSearch.set(ix.enableSearch);
    const s = ix.settings ?? {};
    this.formTorznabBase.set(String(s['baseUrl'] ?? ''));
    this.formTorznabKey.set(String(s['apiKey'] ?? ''));
    this.formMinSeeders.set(Number(s['minSeeders'] ?? 0));
    this.formUnknownLanguage.set(String(s['unknownLanguageIsoCode'] ?? ''));
    this.saveError.set('');
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
    if (!name) {
      this.saveError.set(
        this.translate.instant('settings.indexers.name_required'),
      );
      return;
    }
    const base = this.formTorznabBase().trim();
    if (!base) {
      this.saveError.set(
        this.translate.instant('settings.indexers.base_url_required'),
      );
      return;
    }

    const body = {
      name,
      implementation: 'torznab' as const,
      priority: this.formPriority(),
      enabled: this.formEnabled(),
      enableSearch: this.formEnableSearch(),
      settings: {
        baseUrl: base.replace(/\/$/, ''),
        apiKey: this.formTorznabKey().trim(),
        minSeeders: this.formMinSeeders(),
        unknownLanguageIsoCode: this.formUnknownLanguage() || undefined,
      },
    };

    this.saving.set(true);
    this.saveError.set('');
    const id = this.editingId();
    try {
      await (id == null ? this.api.create(body) : this.api.update(id, body));
      this.closeEditor();
      await this.reloadAll();
    } catch (err: unknown) {
      const httpErr = err as { error?: { message?: string | string[] } };
      const msg = Array.isArray(httpErr.error?.message)
        ? httpErr.error.message.join(', ')
        : httpErr.error?.message;
      this.saveError.set(
        msg ?? this.translate.instant('settings.indexers.save_error'),
      );
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
