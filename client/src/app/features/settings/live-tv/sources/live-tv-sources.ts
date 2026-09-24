import { Component, ElementRef, OnInit, inject, signal, computed, viewChild } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { ConfirmationService } from '../../../../core/services/confirmation.service';
import { ToastService } from '../../../../core/services/toast.service';
import {
  LiveTvApiService,
  AdminSource,
  TestSourceResult,
} from '../../../../core/services/api/livetv-api.service';
import { ModalHeaderComponent } from '../../../../shared/components/modal-header';
import { ModalFooterComponent } from '../../../../shared/components/modal-footer';
import { ErrorBadgeComponent } from '../../../../shared/components/error-badge';
import { TvSelectDirective } from '../../../../shared/directives/tv-select.directive';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';
import { EnabledSwitchComponent } from '../../../../shared/components/enabled-switch';

/** Xtream panels answer a free-form `status` string, never validated against an
 *  enum; only these four values are known across the providers seen in the wild.
 *  Anything else still displays, untranslated, rather than being hidden. */
const ACCOUNT_STATUS_BADGES: Record<string, { labelKey: string; cls: string }> = {
  active: { labelKey: 'liveTv.admin.sources.account_status_active', cls: 'badge-success' },
  expired: { labelKey: 'liveTv.admin.sources.account_status_expired', cls: 'badge-error' },
  banned: { labelKey: 'liveTv.admin.sources.account_status_banned', cls: 'badge-error' },
  disabled: { labelKey: 'liveTv.admin.sources.account_status_disabled', cls: 'badge-ghost' },
};

/** Mirrors the backend's `LIVETV_EXPIRY_WARNING_DAYS`: a week's notice to flag an
 *  expiry date before it actually lapses. */
const EXPIRY_WARNING_DAYS = 7;

@Component({
  selector: 'app-live-tv-sources',
  imports: [
    FormsModule,
    NgClass,
    TranslatePipe,
    LocaleDatePipe,
    TvSelectDirective,
    ModalHeaderComponent,
    ModalFooterComponent,
    ErrorBadgeComponent,
    EnabledSwitchComponent,
  ],
  templateUrl: './live-tv-sources.html',
})
export class LiveTvSourcesComponent implements OnInit {
  private readonly api = inject(LiveTvApiService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly editorDialog = viewChild<ElementRef<HTMLDialogElement>>('editorDialog');

  readonly rows = signal<AdminSource[]>([]);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly syncingId = signal<number | null>(null);
  readonly togglingId = signal<number | null>(null);

  readonly editingId = signal<number | null>(null);
  readonly testLoading = signal(false);
  readonly testResult = signal<TestSourceResult | null>(null);

  readonly formName = signal('');
  readonly formKind = signal<'m3u' | 'xtream'>('m3u');
  readonly formUrl = signal('');
  readonly uploading = signal(false);
  /** True while the URL field holds a server path rather than a link. */
  readonly urlIsFile = computed(() => {
    const url = this.formUrl().trim();
    return url.length > 0 && !/^https?:\/\//i.test(url);
  });
  readonly formUsername = signal('');
  readonly formPassword = signal('');
  readonly formUserAgent = signal('');
  readonly formReferer = signal('');
  readonly formMaxStreams = signal(0);
  readonly formRefreshHours = signal(12);
  readonly formEnabled = signal(true);
  readonly formGroupInclude = signal('');
  readonly formGroupExclude = signal('');
  /** Unlocks `formMaxStreams` for manual editing when the panel already auto-filled it. */
  readonly maxStreamsOverride = signal(false);

  readonly maxStreamsLocked = computed(() => {
    const row = this.editingRowSnapshot();
    return row?.maxStreamsIsManual === false && !this.maxStreamsOverride();
  });

  private editingRowSnapshot(): AdminSource | null {
    const id = this.editingId();
    return id == null ? null : (this.rows().find((r) => r.id === id) ?? null);
  }

  /** `null` for an unrecognised provider string: the raw value still shows in
   *  the template, just without a color or a translated label. */
  accountStatusBadge(status: string): { label: string; cls: string } | null {
    const known = ACCOUNT_STATUS_BADGES[status.toLowerCase()];
    return known ? { label: this.translate.instant(known.labelKey), cls: known.cls } : null;
  }

  /** `null` once the date is further out than the warning window: the plain
   *  date text (already in the template) is enough at that point. */
  expiryBadge(expiresAt: string): { label: string; cls: string } | null {
    const msLeft = new Date(expiresAt).getTime() - Date.now();
    if (msLeft <= 0) {
      return {
        label: this.translate.instant('liveTv.admin.sources.account_status_expired'),
        cls: 'badge-error',
      };
    }
    if (msLeft <= EXPIRY_WARNING_DAYS * 86_400_000) {
      return {
        label: this.translate.instant('liveTv.admin.sources.expiring_soon'),
        cls: 'badge-warning',
      };
    }
    return null;
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      this.rows.set(await this.api.listSources());
    } catch {
      // handled by the global error interceptor
    } finally {
      this.loading.set(false);
    }
  }

  openCreate(): void {
    this.editingId.set(null);
    this.formName.set('');
    this.formKind.set('m3u');
    this.formUrl.set('');
    this.formUsername.set('');
    this.formPassword.set('');
    this.formUserAgent.set('');
    this.formReferer.set('');
    this.formMaxStreams.set(0);
    this.formRefreshHours.set(12);
    this.formEnabled.set(true);
    this.formGroupInclude.set('');
    this.formGroupExclude.set('');
    this.maxStreamsOverride.set(true);
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  openEdit(row: AdminSource): void {
    this.editingId.set(row.id);
    this.formName.set(row.name);
    this.formKind.set(row.kind);
    this.formUrl.set(row.url);
    this.formUsername.set(row.username ?? '');
    this.formPassword.set('');
    this.formUserAgent.set(row.userAgent ?? '');
    this.formReferer.set(row.referer ?? '');
    this.formMaxStreams.set(row.maxStreams);
    this.formRefreshHours.set(row.refreshIntervalHours);
    this.formEnabled.set(row.enabled);
    this.formGroupInclude.set(row.includeGroupsPattern ?? '');
    this.formGroupExclude.set(row.excludeGroupsPattern ?? '');
    this.maxStreamsOverride.set(false);
    this.testResult.set(null);
    this.editorDialog()?.nativeElement.showModal();
  }

  closeEditor(): void {
    this.editorDialog()?.nativeElement.close();
  }

  async testConnection(): Promise<void> {
    const url = this.formUrl().trim();
    if (!url) return;
    this.testLoading.set(true);
    this.testResult.set(null);
    try {
      const row = this.editingRowSnapshot();
      // The stored password never repopulates the form; the id lets the
      // server fall back to it, as long as the type/URL still match the row.
      const testedId =
        row && row.kind === this.formKind() && row.url === url ? row.id : undefined;
      const result = await this.api.testSource({
        ...(testedId != null ? { id: testedId } : {}),
        kind: this.formKind(),
        url,
        username: this.formUsername().trim() || undefined,
        password: this.formPassword().trim() || undefined,
        userAgent: this.formUserAgent().trim() || undefined,
        referer: this.formReferer().trim() || undefined,
        includeGroupsPattern: this.formGroupInclude().trim() || undefined,
        excludeGroupsPattern: this.formGroupExclude().trim() || undefined,
      });
      this.testResult.set(result);
      // Only on a still-untouched field: a value the admin already typed wins.
      if (result.maxConnections != null && this.formMaxStreams() === 0) {
        this.formMaxStreams.set(result.maxConnections);
      }
    } catch {
      this.testResult.set({
        ok: false,
        kind: this.formKind(),
        channelCount: 0,
        onDemandCount: 0,
        groups: [],
        guideUrl: null,
        guideUrls: [],
        maxConnections: null,
        expiresAt: null,
        accountStatus: null,
      });
    } finally {
      this.testLoading.set(false);
    }
  }

  /** A pasted playlist link resolving to a richer Xtream API: one click to adopt it. */
  useSuggestion(): void {
    const suggestion = this.testResult()?.suggestion;
    if (!suggestion) return;
    this.formKind.set(suggestion.suggestedKind);
    this.formUrl.set(suggestion.baseUrl);
    this.formUsername.set(suggestion.username);
    this.formPassword.set(suggestion.password);
    this.testResult.set(null);
  }

  /** A provider mails a playlist file: the server stores it and keeps the path. */
  async onPlaylistPicked(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    try {
      const { location } = await this.api.uploadPlaylist(file);
      this.formKind.set('m3u');
      this.formUrl.set(location);
      this.testResult.set(null);
      this.toast.success(this.translate.instant('liveTv.admin.sources.upload_done'));
    } catch {
      // handled by the global error interceptor
    } finally {
      this.uploading.set(false);
      input.value = '';
    }
  }

  /** Swaps an uploaded copy for the live link rebuilt from its own entries. */
  useLivePlaylistLink(): void {
    const link = this.testResult()?.playlistUrlFromFile;
    if (!link) return;
    this.formUrl.set(link);
    this.testResult.set(null);
  }

  async save(): Promise<void> {
    const name = this.formName().trim();
    const url = this.formUrl().trim();
    if (!name || !url) return;
    const id = this.editingId();
    const maxStreams = this.formMaxStreams();
    // The backend locks it to manual just for being present: skip it at the
    // untouched default on create, and while still panel-locked on edit.
    const sendMaxStreams = id == null ? maxStreams > 0 : !this.maxStreamsLocked();
    const body = {
      name,
      kind: this.formKind(),
      url,
      // '' clears the field on edit; the DTOs and the group-pattern compiler
      // both treat a blank string the same as absent.
      username: this.formUsername().trim(),
      ...(this.formPassword().trim() ? { password: this.formPassword().trim() } : {}),
      userAgent: this.formUserAgent().trim(),
      referer: this.formReferer().trim(),
      ...(sendMaxStreams ? { maxStreams } : {}),
      refreshIntervalHours: this.formRefreshHours(),
      enabled: this.formEnabled(),
      includeGroupsPattern: this.formGroupInclude().trim(),
      excludeGroupsPattern: this.formGroupExclude().trim(),
    };
    this.saving.set(true);
    try {
      await (id == null ? this.api.createSource(body) : this.api.updateSource(id, body));
      this.toast.success(this.translate.instant('liveTv.admin.sources.saved_toast'));
      this.closeEditor();
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.saving.set(false);
    }
  }

  async syncNow(row: AdminSource): Promise<void> {
    this.syncingId.set(row.id);
    try {
      await this.api.syncSource(row.id);
      this.toast.success(this.translate.instant('liveTv.admin.sources.sync_started'));
    } catch {
      // handled by the global error interceptor
    } finally {
      this.syncingId.set(null);
    }
  }

  async toggleEnabled(row: AdminSource): Promise<void> {
    this.togglingId.set(row.id);
    try {
      await this.api.updateSource(row.id, { enabled: !row.enabled });
      await this.reload();
    } catch {
      // handled by the global error interceptor
    } finally {
      this.togglingId.set(null);
    }
  }

  async deleteRow(row: AdminSource): Promise<void> {
    const ok = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('liveTv.admin.sources.confirm_delete', { name: row.name }),
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await this.api.deleteSource(row.id);
      await this.reload();
    } catch {
      // handled by the global error interceptor
    }
  }
}
