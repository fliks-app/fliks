import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideArrowRightLeft,
  LucideBan,
  LucideChevronDown,
  LucideClock,
  LucideCode,
  LucideFileText,
  LucideImage,
  LucideMaximize2,
  LucidePlay,
  LucideSmile,
  LucideThermometer,
  LucideTrash2,
  LucideVolume2,
  LucideZap,
} from '@lucide/angular';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';
import { formatSubtitleLabel } from '../../../core/utils/player.utils';
import { SubtitleFilenamePipe } from '../../pipes/subtitle-filename.pipe';
import {
  MediaStream,
  SubtitleFileRow,
  SubtitleSearchResult,
  SubtitlesApiService,
  SyncOptions,
} from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import {
  LanguageProfile,
  ProfilesService,
} from '../../../core/services/api/profiles.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { MediaDetailSubtitleSearchModalComponent } from '../../../features/media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import type { MediaInfoHeaderSubtitle } from '../media-info-header/media-info-header';

interface SubtitleRow {
  sub?: SubtitleFileRow;
  language: string;
  missing: boolean;
}

/**
 * Self-contained subtitles modal: loads, displays, searches and manages
 * subtitles for a media (or a single episode when `episodeId` is set).
 * Exposes {@link show} / {@link close} so parents can open it from e.g.
 * a header dropdown without owning any of the internal state.
 */
@Component({
  selector: 'app-subtitles-modal',
  imports: [
    FormsModule,
    TranslateModule,
    LocalizeLanguagePipe,
    SubtitleFilenamePipe,
    MediaDetailSubtitleSearchModalComponent,
    LucideArrowRightLeft,
    LucideBan,
    LucideChevronDown,
    LucideClock,
    LucideCode,
    LucideFileText,
    LucideImage,
    LucideMaximize2,
    LucidePlay,
    LucideSmile,
    LucideThermometer,
    LucideTrash2,
    LucideVolume2,
    LucideZap,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitles-modal.html',
})
export class SubtitlesModalComponent {
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly subActions = inject(SubtitleActionsService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly sse = inject(SseService);

  // ── Inputs ──
  readonly mediaId = input.required<number>();
  readonly episodeId = input<number | undefined>(undefined);
  /** All files for this media (or episode files) — used to filter subtitles + find active file */
  readonly files = input<{ id: number; episodeId?: number | null; streamInfo?: any }[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly canGrab = input(false);
  readonly searchDisabled = input(false);
  /** Language profile ID from the media — used to compute required subtitle languages */
  readonly languageProfileId = input<number | null>(null);
  readonly streams = input<MediaStream[]>([]);

  // ── Internal state ──
  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);
  readonly subSearchLang = signal('en');
  readonly subSearchResults = signal<SubtitleSearchResult[]>([]);
  readonly subSearchLoading = signal(false);
  readonly subSearchSearched = signal(false);
  private readonly languageProfiles = signal<LanguageProfile[]>([]);

  // ── Refs ──
  private readonly modal = viewChild<ElementRef<HTMLDialogElement>>('modal');
  private readonly searchModal = viewChild(MediaDetailSubtitleSearchModalComponent);
  private readonly syncDialog = viewChild<ElementRef<HTMLDialogElement>>('syncDialog');
  private readonly adjustDialog = viewChild<ElementRef<HTMLDialogElement>>('adjustDialog');
  private readonly fpsDialog = viewChild<ElementRef<HTMLDialogElement>>('fpsDialog');

  /** Open the subtitles modal. Called from parent via viewChild. */
  show(): void {
    this.modal()?.nativeElement.showModal();
  }

  /** Close the subtitles modal. */
  close(): void {
    this.modal()?.nativeElement.close();
  }

  // ── Pagination + rows ──

  readonly pageSize = 10;
  readonly page = signal(0);

  /** Subtitles filtered for the current episode (if set) */
  private readonly episodeSubtitles = computed(() => {
    const epId = this.episodeId();
    const all = this.subtitles();
    if (!epId) return all;
    const fileIds = new Set(
      this.files()
        .filter((f) => f.episodeId != null && Number(f.episodeId) === epId)
        .map((f) => f.id),
    );
    return all.filter((s) => s.episodeId === epId || fileIds.has(s.mediaFileId));
  });

  /** Subtitles filtered by selected file when multiple files exist */
  readonly filteredSubtitles = computed(() => {
    const all = this.episodeSubtitles();
    const fileId = this.selectedFileId();
    const files = this.files();
    if (!fileId || files.length <= 1) return all;
    return all.filter((s) => s.mediaFileId === fileId);
  });

  /** Required subtitle languages from language profile */
  readonly requiredSubtitleLangs = computed(() => {
    const lpId = this.languageProfileId();
    if (!lpId) return [];
    const lp = this.languageProfiles().find((p) => p.id === lpId);
    return lp?.subtitleLanguages ?? [];
  });

  readonly rows = computed<SubtitleRow[]>(() => {
    const subs = this.filteredSubtitles();
    const required = this.requiredSubtitleLangs();
    const existingLangs = new Set(subs.map((s) => s.language));
    const rows: SubtitleRow[] = subs.map((s) => ({ sub: s, language: s.language, missing: false }));
    for (const lang of required) {
      if (!existingLangs.has(lang.isoCode)) {
        rows.push({ language: lang.isoCode, missing: true });
      }
    }
    return rows;
  });

  readonly hasMissing = computed(() => this.rows().some((r) => r.missing));
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.rows().length / this.pageSize)));
  readonly pagedRows = computed(() => {
    const start = this.page() * this.pageSize;
    return this.rows().slice(start, start + this.pageSize);
  });

  goToPage(p: number) {
    this.page.set(Math.max(0, Math.min(p, this.totalPages() - 1)));
  }

  /** Formatted subtitles for the media-info-header dropdown */
  readonly headerSubtitles = computed<MediaInfoHeaderSubtitle[]>(() => {
    const subs = this.filteredSubtitles();
    return subs.map((s) => {
      const id = s.streamIndex != null ? `emb-${s.streamIndex}` : `ext-${s.id}`;
      return {
        id,
        label: formatSubtitleLabel(s, this.translate),
        language: s.language,
        forced: s.forced,
      };
    });
  });

  // ── Streams / action modals ──

  readonly audioStreams = computed(() => this.streams().filter((s) => s.type === 'audio'));
  readonly subtitleStreams = computed(() => this.streams().filter((s) => s.type === 'subtitle'));
  /** External subtitle files usable as sync reference (excluding the one being synced) */
  readonly externalSubtitleRefs = computed(() =>
    this.subtitles().filter((s) => s.relativePath && s.id !== this.syncSubtitleId()),
  );

  // Sync modal state
  readonly syncSubtitleId = signal<number | null>(null);
  readonly syncReference = signal('auto');
  readonly syncMaxOffset = signal('');
  readonly syncNoFixFramerate = signal(false);
  readonly syncGoldenSection = signal(false);

  openSyncModal(subtitleId: number) {
    this.syncSubtitleId.set(subtitleId);
    this.syncReference.set('auto');
    this.syncMaxOffset.set('');
    this.syncNoFixFramerate.set(false);
    this.syncGoldenSection.set(false);
    this.syncDialog()?.nativeElement.showModal();
  }

  closeSyncModal() {
    this.syncDialog()?.nativeElement.close();
  }

  confirmSync() {
    const id = this.syncSubtitleId();
    if (id == null) return;
    const options: SyncOptions = {};
    const ref = this.syncReference().trim();
    if (ref && ref !== 'auto') options.reference = ref;
    const maxOffset = Number(this.syncMaxOffset());
    if (maxOffset > 0) options.maxOffsetSeconds = maxOffset;
    if (this.syncNoFixFramerate()) options.noFixFramerate = true;
    if (this.syncGoldenSection()) options.goldenSectionSearch = true;
    void this.syncSubtitle({ subtitleId: id, options });
    this.closeSyncModal();
  }

  // Adjust Times modal state
  readonly adjustSubtitleId = signal<number | null>(null);
  readonly adjustMinutes = signal('0');
  readonly adjustSeconds = signal('0');
  readonly adjustMillis = signal('0');

  openAdjustModal(subtitleId: number) {
    this.adjustSubtitleId.set(subtitleId);
    this.adjustMinutes.set('0');
    this.adjustSeconds.set('0');
    this.adjustMillis.set('0');
    this.adjustDialog()?.nativeElement.showModal();
  }

  closeAdjustModal() {
    this.adjustDialog()?.nativeElement.close();
  }

  confirmAdjust() {
    const id = this.adjustSubtitleId();
    if (id == null) return;
    const offsetMs =
      Number(this.adjustMinutes()) * 60000 +
      Number(this.adjustSeconds()) * 1000 +
      Number(this.adjustMillis());
    void this.postProcessSubtitle({ subtitleId: id, action: 'adjustTimes', params: { offsetMs } });
    this.closeAdjustModal();
  }

  // Change Frame Rate modal state
  readonly fpsSubtitleId = signal<number | null>(null);
  readonly fpsFrom = signal('23.976');
  readonly fpsTo = signal('25');

  openFpsModal(subtitleId: number) {
    this.fpsSubtitleId.set(subtitleId);
    this.fpsFrom.set('23.976');
    this.fpsTo.set('25');
    this.fpsDialog()?.nativeElement.showModal();
  }

  closeFpsModal() {
    this.fpsDialog()?.nativeElement.close();
  }

  confirmFps() {
    const id = this.fpsSubtitleId();
    if (id == null) return;
    void this.postProcessSubtitle({
      subtitleId: id,
      action: 'changeFrameRate',
      params: { fromFps: Number(this.fpsFrom()), toFps: Number(this.fpsTo()) },
    });
    this.closeFpsModal();
  }

  // ── Auto-load subtitles ──

  private lastSseEvent: any = null;

  private readonly loadEffect = effect(() => {
    const mediaId = this.mediaId();
    if (mediaId) void this.loadSubtitles(mediaId);
  });

  private readonly loadProfilesEffect = effect(() => {
    const lpId = this.languageProfileId();
    if (lpId && !this.languageProfiles().length) {
      this.profilesApi.getLanguageProfiles().then((lp) => this.languageProfiles.set(lp)).catch(() => {});
    }
  });

  /** SSE: reload subtitles on sync/download events */
  private readonly sseEffect = effect(() => {
    const event = this.sse.lastEvent();
    const mediaId = this.mediaId();
    if (!event || !mediaId) return;
    if ((event['mediaId'] as number) !== mediaId) return;
    if (event === this.lastSseEvent) return;
    this.lastSseEvent = event;

    if (event.type === 'subtitle.synced') {
      this.toast.success(this.translate.instant('sse.subtitle_synced'));
      void this.loadSubtitles(mediaId);
    } else if (event.type === 'subtitle.downloaded') {
      this.toast.success(
        this.translate.instant('sse.subtitle_downloaded', {
          title: event['title'] ?? '',
          lang: event['language'] ?? '',
        }),
      );
      void this.loadSubtitles(mediaId);
    }
  });

  // ── Actions ──

  async loadSubtitles(mediaId: number) {
    this.subtitlesLoading.set(true);
    try {
      this.subtitles.set(await this.subtitlesApi.getForMedia(mediaId));
    } catch {
      this.subtitles.set([]);
    } finally {
      this.subtitlesLoading.set(false);
    }
  }

  async autoSubtitle() {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    await this.subActions.autoDownload(
      this.mediaId(),
      fileId,
      this.subSearchLang(),
      this.subtitles,
      this.subtitleActionBusy,
      this.episodeId(),
    );
  }

  openSubtitleSearch() {
    this.subSearchResults.set([]);
    this.subSearchSearched.set(false);
    this.searchModal()?.showModal();
  }

  async searchSubtitles() {
    this.subSearchLoading.set(true);
    try {
      const results = await this.subActions.search(
        this.mediaId(),
        this.subSearchLang(),
        this.episodeId(),
      );
      this.subSearchResults.set(results);
      this.subSearchSearched.set(true);
    } catch {
      this.subSearchResults.set([]);
    } finally {
      this.subSearchLoading.set(false);
    }
  }

  async downloadSearchResult(r: SubtitleSearchResult) {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    await this.subActions.download(
      this.mediaId(),
      fileId,
      r,
      this.subtitles,
      this.subtitleActionBusy,
      this.episodeId(),
    );
  }

  async syncSubtitle(event: { subtitleId: number; options: SyncOptions }) {
    await this.subActions.sync(this.mediaId(), event.subtitleId, event.options);
  }

  async postProcessSubtitle(event: {
    subtitleId: number;
    action: string;
    params?: Record<string, unknown>;
  }) {
    await this.subActions.postProcess(this.mediaId(), event.subtitleId, event.action, event.params);
    await this.loadSubtitles(this.mediaId());
  }

  async blacklistSubtitle(sub: SubtitleFileRow) {
    await this.subActions.blacklist(this.mediaId(), sub, this.subtitles);
  }

  async deleteSubtitle(subtitleId: number) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('common.confirm'),
        message: this.translate.instant('media_detail.confirm_delete_subtitle'),
        variant: 'danger',
      }))
    )
      return;
    await this.subActions.remove(this.mediaId(), subtitleId, this.subtitles, this.subtitleActionBusy);
  }
}
