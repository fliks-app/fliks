import { Component, ElementRef, OnInit, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ToastService } from '../../../../core/services/toast.service';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import {
  LiveTvApiService,
  GuideSource,
  GuideMatchReport,
  AdminSource,
} from '../../../../core/services/api/livetv-api.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { ErrorBadgeComponent } from '../../../../shared/components/error-badge';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';

@Component({
  selector: 'app-live-tv-guide-admin',
  imports: [
    FormsModule,
    TranslatePipe,
    LocaleDatePipe,
    TvSelectDirective,
    ModalHeaderComponent,
    ModalFooterComponent,
    ErrorBadgeComponent,
  ],
  templateUrl: './live-tv-guide-admin.html',
})
export class LiveTvGuideAdminComponent implements OnInit {
  private readonly api = inject(LiveTvApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly sources = signal<AdminSource[]>([]);
  readonly rows = signal<GuideSource[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly syncingId = signal<number | null>(null);
  readonly togglingId = signal<number | null>(null);

  readonly report = signal<GuideMatchReport | null>(null);
  readonly reportLoading = signal(true);
  /** channelId -> displayName typed/picked in the datalist input. */
  readonly pickedDisplayName = signal<Partial<Record<number, string>>>({});
  readonly applyingChannelId = signal<number | null>(null);

  readonly editingId = signal<number | null>(null);
  readonly formName = signal('');
  readonly formKind = signal<'xmltv' | 'source'>('xmltv');
  readonly formUrl = signal('');
  readonly formSourceId = signal<number | null>(null);
  readonly formRefreshHours = signal(12);
  readonly formTimezoneOffset = signal(0);
  readonly formEnabled = signal(true);

  ngOnInit(): void {
    void this.api.listSources().then((s) => this.sources.set(s)).catch(() => {});
    void this.reload();
    void this.loadReport();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.rows.set(await this.api.listGuideSources());
    } catch {
      // handled by the global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  async loadReport(): Promise<void> {
    this.reportLoading.set(true);
    try {
      this.report.set(await this.api.getMatchReport());
    } catch {
      // handled by the global error interceptor
    } finally {
      this.reportLoading.set(false);
    }
  }

  openCreate(): void {
    this.editingId.set(null);
    this.formName.set('');
    this.formKind.set('xmltv');
    this.formUrl.set('');
    this.formSourceId.set(this.sources()[0]?.id ?? null);
    this.formRefreshHours.set(12);
    this.formTimezoneOffset.set(0);
    this.formEnabled.set(true);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(row: GuideSource): void {
    this.editingId.set(row.id);
    this.formName.set(row.name);
    this.formKind.set(row.kind);
    this.formUrl.set(row.url ?? '');
    this.formSourceId.set(row.sourceId);
    this.formRefreshHours.set(row.refreshIntervalHours);
    this.formTimezoneOffset.set(row.timezoneOffsetMinutes);
    this.formEnabled.set(row.enabled);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor(): void {
    this.editorDialog()?.nativeElement.close();
  }

  async save(): Promise<void> {
    const name = this.formName().trim();
    if (!name) return;
    const body = {
      name,
      kind: this.formKind(),
      url: this.formKind() === 'xmltv' ? this.formUrl().trim() || null : null,
      sourceId: this.formKind() === 'source' ? this.formSourceId() : null,
      refreshIntervalHours: this.formRefreshHours(),
      timezoneOffsetMinutes: this.formTimezoneOffset(),
      enabled: this.formEnabled(),
    };
    this.saving.set(true);
    try {
      const id = this.editingId();
      await (id == null ? this.api.createGuideSource(body) : this.api.updateGuideSource(id, body));
      this.closeEditor();
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async toggleEnabled(row: GuideSource): Promise<void> {
    this.togglingId.set(row.id);
    try {
      await this.api.updateGuideSource(row.id, { enabled: !row.enabled });
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  async syncNow(row: GuideSource): Promise<void> {
    this.syncingId.set(row.id);
    try {
      await this.api.syncGuideSource(row.id);
      this.toast.success(this.translate.instant('liveTv.admin.guide.sync_started'));
    } catch {
      // handled by the global error interceptor
    } finally {
      this.syncingId.set(null);
    }
  }

  async deleteRow(row: GuideSource): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('liveTv.admin.guide.confirm_delete', { name: row.name }),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.deleteGuideSource(row.id);
      await this.reload();
    } catch {
      // handled by the global error interceptor
    }
  }

  setPickedDisplayName(channelId: number, value: string): void {
    this.pickedDisplayName.update((m) => ({ ...m, [channelId]: value }));
  }

  async applyManualMatch(channelId: number): Promise<void> {
    const displayName = this.pickedDisplayName()[channelId];
    const candidate = this.report()?.candidates.find((c) => c.displayName === displayName);
    if (!candidate) return;
    this.applyingChannelId.set(channelId);
    try {
      await this.api.updateChannel(channelId, { guideChannelId: candidate.id });
      this.toast.success(this.translate.instant('liveTv.admin.guide.match_applied'));
      await this.loadReport();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.applyingChannelId.set(null);
    }
  }
}
