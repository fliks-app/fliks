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
import { isImageBasedSubtitleCodec } from '../../../core/utils/subtitle-codecs';
import { AppSettingsService } from '../../../core/services/app-settings.service';
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
import { PaginationComponent } from '../pagination/pagination';
import { MediaDetailSubtitleSearchModalComponent } from '../../../features/media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import { PopoverMenuComponent } from '../popover-menu';
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
    PaginationComponent,
    MediaDetailSubtitleSearchModalComponent,
    PopoverMenuComponent,
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
  private readonly appSettings = inject(AppSettingsService);

  constructor() {
    // Header subtitle chips honour the hide-burn-in app setting; load it once.
    void this.appSettings.ensureLoaded();
  }

  // ── Inputs ──
  readonly mediaId = input.required<number>();
  readonly episodeId = input<number | undefined>(undefined);
  /** All files for this media (or episode files) — used to filter subtitles + find active file */
  readonly files = input<{ id: number; episodeId?: number | null; streamInfo?: any }[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly canManage = input(false);
  readonly searchDisabled = input(false);
  /** Language profile ID from the media — used to compute required subtitle languages */
  readonly languageProfileId = input<number | null>(null);
  readonly streams = input<MediaStream[]>([]);

  // ── Internal state ──
  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);

  /** Row whose Actions popover is currently open. `null` when closed.
   *  A single popover instance is reused for every row; `actionsSub()`
   *  resolves the active row's data inside the popover template. */
  readonly actionsOpenForId = signal<number | null>(null);
  readonly actionsAnchor = signal<HTMLElement | null>(null);
  /** Drives the actions popover's `[open]`. Kept separate from
   *  `actionsOpenForId` so the content stays rendered through the slide-down
   *  exit — the row id (content source) is cleared only once `(closed)` fires
   *  after the animation, so the menu's buttons don't flip mid-slide. */
  readonly actionsMenuOpen = signal(false);
  readonly actionsSub = computed(() => {
    const id = this.actionsOpenForId();
    return id == null ? null : this.subtitles().find((s) => s.id === id) ?? null;
  });
  /** The open row is an image-based (burn-required) track — offer OCR instead
   *  of the text-only post-processing actions. */
  readonly actionsSubIsImage = computed(() =>
    isImageBasedSubtitleCodec(this.actionsSub()?.codec),
  );
  /** Embedded tracks have no sidecar file: blacklist/delete don't apply. */
  readonly actionsSubIsEmbedded = computed(
    () => this.actionsSub()?.providerType === 'embedded',
  );

  /** Whether a row should expose the Actions menu — external files always, and
   *  embedded image tracks so they can be OCR'd to text. */
  protected rowHasActions(sub: SubtitleFileRow): boolean {
    return sub.providerType !== 'embedded' || isImageBasedSubtitleCodec(sub.codec);
  }

  protected openSubActions(sub: SubtitleFileRow, anchor: HTMLElement) {
    this.actionsAnchor.set(anchor);
    this.actionsOpenForId.set(sub.id);
    this.actionsMenuOpen.set(true);
  }
  /** `(closed)` handler — fires after the slide-down completes, so the row's
   *  data is safe to drop here. */
  protected closeSubActions() {
    this.actionsMenuOpen.set(false);
    this.actionsOpenForId.set(null);
    this.actionsAnchor.set(null);
  }
  protected runSubAction(action: (sub: SubtitleFileRow) => void): void {
    const sub = this.actionsSub();
    if (!sub) return;
    // Start the close animation but keep the row's data until `(closed)` clears
    // it, so the menu's buttons don't flip while the sheet slides out.
    this.actionsMenuOpen.set(false);
    action(sub);
  }
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
  private readonly ocrLangDialog = viewChild<ElementRef<HTMLDialogElement>>('ocrLangDialog');

  // OCR language picker (used when an image track is untagged — 'und').
  readonly ocrLangCodes: readonly string[] = [
    'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'fi',
    'pl', 'cs', 'sk', 'hu', 'ro', 'el', 'ru', 'uk', 'bg', 'sr', 'hr',
    'tr', 'ar', 'he', 'fa', 'hi', 'th', 'vi', 'id', 'ja', 'ko', 'zh',
  ];
  private readonly ocrTargetId = signal<number | null>(null);
  readonly ocrLang = signal('en');
  /** The language dialog drives both OCR (pick before converting) and relabel
   *  (reassign an existing subtitle's language afterwards). */
  readonly langDialogMode = signal<'ocr' | 'relabel'>('ocr');

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
    const hideBurnIn = this.appSettings.hideBurnInSubtitles();
    const subs = this.filteredSubtitles().filter(
      (s) => !(hideBurnIn && isImageBasedSubtitleCodec(s.codec)),
    );
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

  async searchMissing() {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    await this.subActions.searchMissing(
      this.mediaId(),
      fileId,
      this.subtitles,
      this.subtitleActionBusy,
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

  /** Image-row OCR. With a known language go straight to it; otherwise let the
   *  user pick one first — an untagged 'und' track can't be inferred. */
  ocrSubtitle(sub: SubtitleFileRow) {
    const lang = (sub.language ?? '').toLowerCase();
    if (lang && lang !== 'und' && lang !== 'undefined') {
      void this.triggerOcr(sub.id);
      return;
    }
    this.langDialogMode.set('ocr');
    this.ocrTargetId.set(sub.id);
    this.ocrLang.set('en');
    this.ocrLangDialog()?.nativeElement.showModal();
  }

  /** Reassign a subtitle's language afterwards — e.g. an OCR done with a
   *  best-guess language on an untagged track. Relabels only; doesn't re-OCR. */
  changeLanguage(sub: SubtitleFileRow) {
    const lang = (sub.language ?? '').toLowerCase();
    this.langDialogMode.set('relabel');
    this.ocrTargetId.set(sub.id);
    this.ocrLang.set(lang && lang !== 'und' && lang !== 'undefined' ? lang : 'en');
    this.ocrLangDialog()?.nativeElement.showModal();
  }

  confirmLanguage() {
    const id = this.ocrTargetId();
    this.ocrLangDialog()?.nativeElement.close();
    if (id == null) return;
    if (this.langDialogMode() === 'ocr') {
      void this.triggerOcr(id, this.ocrLang());
    } else {
      void this.subActions
        .setLanguage(this.mediaId(), id, this.subtitles, this.subtitleActionBusy, this.ocrLang());
    }
  }

  closeOcrLangModal() {
    this.ocrLangDialog()?.nativeElement.close();
  }

  private async triggerOcr(subtitleId: number, language?: string) {
    await this.subActions.ocr(
      this.mediaId(),
      subtitleId,
      this.subtitles,
      this.subtitleActionBusy,
      language,
    );
    this.toast.info(this.translate.instant('media_detail.ocr_started'));
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
