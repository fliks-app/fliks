import {
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
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LucideChevronDown,
  LucideUpload,
} from '@lucide/angular';
import { LocalizeLanguagePipe } from '../../../core/pipes/localize-language.pipe';
import { formatSubtitleLabel, formatSubtitleParts } from '../../../core/utils/player.utils';
import { guessLanguageFromFilename, localizeLanguage } from '../../../core/utils/language.utils';
import {
  isImageBasedSubtitleCodec,
  isOcrSupportedSubtitleCodec,
} from '../../../core/utils/subtitle-codecs';
import { SUBTITLE_LANGUAGE_CODES } from '../../../core/constants/subtitle-languages';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { DeviceService } from '../../../core/services/device.service';
import { SubtitleFilenamePipe } from '../../pipes/subtitle-filename.pipe';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { SubtitleViewerModalComponent } from '../subtitle-viewer-modal/subtitle-viewer-modal';
import {
  MediaStream,
  SubtitleFileRow,
  SubtitleSearchResult,
  SubtitlesApiService,
  SyncOptions,
} from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import {
  CardAction,
  CardActionsService,
} from '../../../core/services/card-actions.service';
import {
  TranslationProvidersApiService,
  AvailableTranslationProvider,
} from '../../../core/services/api/translation-providers-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { LanguageProfile, ProfilesService } from '../../../core/services/api/profiles.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { PaginationComponent } from '../pagination/pagination';
import { MediaDetailSubtitleSearchModalComponent } from '../../../features/media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import type { MediaInfoHeaderSubtitle } from '../media-info-header/media-info-header';
import { ModalHeaderComponent } from '../modal-header';
import { ModalFooterComponent } from '../modal-footer';

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
  imports: [TvSelectDirective, 
    ModalFooterComponent,
    ModalHeaderComponent,
    FormsModule,
    TranslatePipe,
    LocalizeLanguagePipe,
    SubtitleFilenamePipe,
    PaginationComponent,
    MediaDetailSubtitleSearchModalComponent,
    SubtitleViewerModalComponent,
    LucideChevronDown,
    LucideUpload,
  ],
  templateUrl: './subtitles-modal.html',
})
export class SubtitlesModalComponent {
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly subActions = inject(SubtitleActionsService);
  private readonly translationProvidersApi = inject(TranslationProvidersApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly profilesApi = inject(ProfilesService);
  private readonly sse = inject(SseService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly device = inject(DeviceService);

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

  private readonly cardActions = inject(CardActionsService);

  private readonly viewer = viewChild<SubtitleViewerModalComponent>('subtitleViewer');

  protected readonly canDownload = this.device.canSaveFiles;

  /** Name for the anchor's `download`, so a same-origin save keeps it even if
   *  `Content-Disposition` is lost in transit. */
  protected subtitleDownloadName(sub: SubtitleFileRow | null): string {
    if (!sub) return '';
    if (sub.relativePath) {
      return sub.relativePath.replace(/\\/g, '/').split('/').pop() ?? '';
    }
    return `track-${sub.streamIndex}.${sub.language || 'und'}.vtt`;
  }

  /** Sidecar → the stored file; embedded → the extracted WebVTT. */
  protected subtitleDownloadUrl(sub: SubtitleFileRow | null): string {
    if (!sub) return '';
    return sub.relativePath
      ? this.streamingApi.getSubtitleDownloadUrl(sub.mediaFileId, sub.id)
      : this.streamingApi.getEmbeddedSubtitleDownloadUrl(sub.mediaFileId, sub.streamIndex!);
  }

  /** Reads the playback WebVTT, so an embedded track is extracted on demand. */
  protected viewSubtitle(sub: SubtitleFileRow): void {
    const url = sub.relativePath
      ? this.streamingApi.getSubtitleUrl(sub.mediaFileId, sub.id)
      : this.streamingApi.getEmbeddedSubtitleUrl(sub.mediaFileId, sub.streamIndex!);
    void this.viewer()?.open(formatSubtitleLabel(sub, this.translate), url);
  }

  /** Every present subtitle row has at least one action or an informational
   *  note (external → full menu, image track → OCR/burn-in note, embedded text
   *  → translate), so the Actions menu is always offered. */
  protected rowHasActions(_sub: SubtitleFileRow): boolean {
    return true;
  }

  /** Everything the row offers, as one declarative tree handed to the shared
   *  actions panel: it renders the anchored dropdown on desktop and the sheet
   *  (submenus swapping in place) on touch and TV. */
  private buildSubActions(sub: SubtitleFileRow): CardAction[] {
    const run = (fn: (s: SubtitleFileRow) => void) => () => fn(sub);
    const embedded = sub.providerType === 'embedded';
    const image = isImageBasedSubtitleCodec(sub.codec);
    const hasTextCues =
      !image && (!!sub.relativePath || sub.streamIndex != null);
    const actions: CardAction[] = [];

    if (image) {
      actions.push(
        isOcrSupportedSubtitleCodec(sub.codec)
          ? {
              labelKey: 'media_detail.action_ocr_extract',
              icon: 'file-text',
              run: run((s) => this.ocrSubtitle(s)),
            }
          : {
              // Image codecs with no OCR path (DVB/XSUB) only get the note.
              labelKey: 'media_detail.ocr_unavailable',
              icon: 'file-text',
              disabled: true,
              run: () => {},
            },
      );
    } else {
      if (hasTextCues) {
        actions.push({
          labelKey: 'media_detail.action_view_subtitle',
          icon: 'eye',
          run: run((s) => this.viewSubtitle(s)),
        });
        if (this.canDownload()) {
          actions.push({
            labelKey: 'media_detail.action_download_subtitle',
            icon: 'download',
            href: this.subtitleDownloadUrl(sub),
            download: this.subtitleDownloadName(sub),
            run: () => {},
          });
        }
        actions.push({
          labelKey: 'media_detail.translate',
          icon: 'languages',
          run: run((s) => this.translateSubtitle(s)),
        });
      }
      if (!embedded) {
        actions.push(
          {
            labelKey: 'media_detail.change_language',
            icon: 'arrow-right-left',
            run: run((s) => this.changeLanguage(s)),
          },
          {
            labelKey: 'media_detail.offset',
            icon: 'move-horizontal',
            run: () => {},
            children: [
              {
                labelKey: 'media_detail.action_sync',
                icon: 'play',
                run: run((s) => this.openSyncModal(s.id)),
              },
              {
                labelKey: 'media_detail.action_adjust_times',
                icon: 'clock',
                run: run((s) => this.openAdjustModal(s.id)),
              },
              {
                labelKey: 'media_detail.action_change_fps',
                icon: 'zap',
                run: run((s) => this.openFpsModal(s.id)),
              },
            ],
          },
          {
            labelKey: 'media_detail.corrections',
            icon: 'wand-sparkles',
            run: () => {},
            children: (
              [
                ['media_detail.action_remove_hi', 'volume-2', 'removeHiTags'],
                ['media_detail.action_remove_style', 'code', 'removeStyleTags'],
                ['media_detail.action_remove_emoji', 'smile', 'removeEmoji'],
                ['media_detail.action_ocr_fixes', 'image', 'ocrFixes'],
                ['media_detail.action_common_fixes', 'thermometer', 'commonFixes'],
                ['media_detail.action_fix_uppercase', 'maximize-2', 'fixUppercase'],
                ['media_detail.action_reverse_rtl', 'arrow-right-left', 'reverseRtl'],
                ['media_detail.action_convert_srt', 'file-text', 'convertToSrt'],
              ] as const
            ).map(([labelKey, icon, action]) => ({
              labelKey,
              icon,
              run: run((s) =>
                this.postProcessSubtitle({ subtitleId: s.id, action }),
              ),
            })),
          },
        );
        if ((sub.score ?? 0) !== 100) {
          actions.push({
            labelKey: 'media_detail.action_validate',
            icon: 'badge-check',
            tone: 'success',
            run: run((s) => this.validateSubtitle(s)),
          });
        }
      }
    }

    if (!embedded) {
      actions.push(
        {
          labelKey: 'media_detail.action_blacklist',
          icon: 'ban',
          tone: 'warning',
          section: 'remove',
          run: run((s) => this.blacklistSubtitle(s)),
        },
        {
          labelKey: 'media_detail.action_delete',
          icon: 'trash-2',
          tone: 'danger',
          section: 'remove',
          run: run((s) => this.deleteSubtitle(s.id)),
        },
      );
    }
    return actions;
  }

  protected openSubActions(sub: SubtitleFileRow, anchor: HTMLElement) {
    this.cardActions.register({
      actions: this.buildSubActions(sub),
      anchor,
      title: formatSubtitleLabel(sub, this.translate),
      placement: 'button',
    });
    this.cardActions.show();
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
    'en',
    'fr',
    'de',
    'es',
    'it',
    'pt',
    'nl',
    'sv',
    'da',
    'no',
    'fi',
    'pl',
    'cs',
    'sk',
    'hu',
    'ro',
    'el',
    'ru',
    'uk',
    'bg',
    'sr',
    'hr',
    'tr',
    'ar',
    'he',
    'fa',
    'hi',
    'th',
    'vi',
    'id',
    'ja',
    'ko',
    'zh',
  ];
  private readonly ocrTargetId = signal<number | null>(null);
  readonly ocrLang = signal('en');
  /** Enabled translation providers, loaded when the translate dialog opens; the
   *  user picks one (default preselected). */
  readonly translationProviders = signal<AvailableTranslationProvider[]>([]);
  readonly selectedTranslationProviderId = signal<number | null>(null);
  /** The language dialog drives OCR (pick before converting), relabel (reassign
   *  an existing subtitle's language), translate (pick the target language) and
   *  upload (tag the file the user just picked). */
  readonly langDialogMode = signal<'ocr' | 'relabel' | 'translate' | 'upload'>('ocr');
  /** Codes offered in the language dialog: the full subtitle set for translation
   *  targets and uploads, the OCR-capable subset otherwise. */
  readonly langDialogCodes = computed<readonly string[]>(() =>
    this.langDialogMode() === 'translate' || this.langDialogMode() === 'upload'
      ? SUBTITLE_LANGUAGE_CODES
      : this.ocrLangCodes,
  );

  /** A file picker reaches the OS on every platform but a TV, which has no
   *  local storage to browse. Both Capacitor WebViews handle <input type=file>
   *  natively, unlike downloads. */
  readonly canPickFiles = computed(() => !this.device.isTv());
  /** Android's picker filters by MIME and its table maps none of the subtitle
   *  extensions, so anything narrower than a wildcard greys out every file. */
  readonly uploadAccept = computed(() =>
    this.device.isAndroidNative() ? '*/*' : '.srt,.ass,.ssa,.vtt,.sub,text/plain',
  );
  private readonly uploadInput = viewChild<ElementRef<HTMLInputElement>>('uploadInput');
  /** File chosen in the picker, held until the language dialog is confirmed. */
  private readonly pendingUpload = signal<File | null>(null);
  readonly pendingUploadName = computed(() => this.pendingUpload()?.name ?? '');

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

  /** Localized languages of OCR runs still in progress, surfaced by the detail
   *  page as an "extraction en cours" indicator. */
  readonly ocrInProgress = computed<string[]>(() =>
    this.filteredSubtitles()
      .filter((s) => s.status === 'processing' && s.providerType === 'ocr')
      .map((s) => localizeLanguage(s.language, this.translate)),
  );

  /** Localized languages (with live percentage) of translation runs still in
   *  progress, surfaced by the detail page as a "traduction en cours" progress
   *  bar. `percent` is null until the first batch reports. */
  readonly translationInProgress = computed<{ language: string; percent: number | null }[]>(() => {
    const progress = this.sse.translationProgress();
    return this.filteredSubtitles()
      .filter((s) => s.status === 'processing' && s.providerType === 'translated')
      .map((s) => ({
        language: localizeLanguage(s.language, this.translate),
        percent: progress[s.id] ?? null,
      }));
  });

  /** Live translation percentage for a PROCESSING row, or null before the first
   *  batch reports. */
  protected translationPercent(id: number): number | null {
    return this.sse.translationProgress()[id] ?? null;
  }

  /** Formatted subtitles for the media-info-header dropdown */
  readonly headerSubtitles = computed<MediaInfoHeaderSubtitle[]>(() => {
    const hideBurnIn = this.appSettings.hideBurnInSubtitles();
    // A subtitle only belongs in the header selector once it's a servable
    // file: an OCR run still processing (or one that failed) isn't playable.
    const subs = this.filteredSubtitles().filter(
      (s) =>
        s.status !== 'processing' &&
        s.status !== 'failed' &&
        !(hideBurnIn && isImageBasedSubtitleCodec(s.codec)),
    );
    const labelOpts = { showFormat: this.appSettings.showSubtitleFormat() };
    return subs.map((s, i) => {
      const id = s.streamIndex != null ? `emb-${s.streamIndex}` : `ext-${s.id}`;
      const parts = formatSubtitleParts(s, this.translate, i + 1, labelOpts);
      return {
        id,
        label: parts.sub ? `${parts.head} — ${parts.sub}` : parts.head,
        head: parts.head,
        sub: parts.sub,
        language: s.language,
        forced: s.forced,
        hearingImpaired: s.hearingImpaired,
        image: isImageBasedSubtitleCodec(s.codec),
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
      this.profilesApi
        .getLanguageProfiles()
        .then((lp) => this.languageProfiles.set(lp))
        .catch(() => {});
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

    const automatic = event['automatic'] === true;
    if (event.type === 'subtitle.list_changed') {
      // Carries no outcome to announce — it says the list moved, nothing more.
      void this.loadSubtitles(mediaId);
    } else if (event.type === 'subtitle.synced') {
      if (!automatic) this.toast.success(this.translate.instant('sse.subtitle_synced'));
      void this.loadSubtitles(mediaId);
    } else if (event.type === 'subtitle.downloaded') {
      if (!automatic) {
        this.toast.success(
          this.translate.instant('sse.subtitle_downloaded', {
            title: event['title'] ?? '',
            lang: event['language'] ?? '',
          }),
        );
      }
      void this.loadSubtitles(mediaId);
    } else if (event.type === 'subtitle.failed') {
      if (!automatic) {
        this.toast.error(
          this.translate.instant(
            event['reason'] === 'rate_limit'
              ? 'media_detail.translation_rate_limited'
              : 'sse.subtitle_failed',
            { lang: event['language'] ?? '' },
          ),
        );
      }
      void this.loadSubtitles(mediaId);
    }
  });

  // ── Actions ──

  async loadSubtitles(mediaId: number) {
    this.subtitlesLoading.set(true);
    try {
      this.subtitles.set(await this.subtitlesApi.getForMedia(mediaId));
      // Drop progress entries for translations that finished/failed so the map
      // never keeps stale rows across runs.
      this.sse.retainTranslationProgress(
        this.subtitles()
          .filter((s) => s.status === 'processing' && s.providerType === 'translated')
          .map((s) => s.id),
      );
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

  /** Mark a subtitle as validated (pins its score to 100). */
  async validateSubtitle(sub: SubtitleFileRow) {
    if (
      !(await this.confirmation.confirm({
        title: this.translate.instant('media_detail.action_validate'),
        message: this.translate.instant('media_detail.confirm_validate_subtitle'),
        confirmLabel: this.translate.instant('media_detail.action_validate'),
      }))
    )
      return;
    await this.subActions.validate(this.mediaId(), sub.id, this.subtitles, this.subtitleActionBusy);
    this.toast.success(this.translate.instant('media_detail.validate_success'));
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

  /** Display label for a translated sub's provider column: the admin-given
   *  provider name (snapshotted at translation time), falling back to the engine
   *  and then a generic "translated" for rows created before provenance existed. */
  translationServiceLabel(sub: SubtitleFileRow): string {
    if (sub.translationProviderName) return sub.translationProviderName;
    switch (sub.translationEngine) {
      case 'gemini':
        return 'Gemini';
      case 'openai':
        return 'OpenAI';
      case 'libretranslate':
        return 'LibreTranslate';
      default:
        return this.translate.instant('player.subtitle_source.translated');
    }
  }

  /** Translate a text subtitle: pick the target language and provider first. */
  async translateSubtitle(sub: SubtitleFileRow) {
    let providers: AvailableTranslationProvider[] = [];
    try {
      providers = await this.translationProvidersApi.getAvailable();
    } catch {
      return; // global interceptor surfaced the error
    }
    if (providers.length === 0) {
      this.toast.error(this.translate.instant('media_detail.translate_no_providers'));
      return;
    }
    this.translationProviders.set(providers);
    this.selectedTranslationProviderId.set((providers.find((p) => p.isDefault) ?? providers[0]).id);
    const src = (sub.language ?? '').toLowerCase();
    this.langDialogMode.set('translate');
    this.ocrTargetId.set(sub.id);
    this.ocrLang.set(src === 'en' ? 'fr' : 'en');
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

  /** Open the OS file picker. */
  pickSubtitleFile() {
    const input = this.uploadInput()?.nativeElement;
    if (!input) return;
    input.value = ''; // re-picking the same file must still fire (change)
    input.click();
  }

  /** A file was picked: guess its language from the name, then let the user confirm. */
  onSubtitleFilePicked(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.pendingUpload.set(file);
    this.langDialogMode.set('upload');
    this.ocrLang.set(guessLanguageFromFilename(file.name, SUBTITLE_LANGUAGE_CODES) ?? 'en');
    this.ocrLangDialog()?.nativeElement.showModal();
  }

  private async uploadPendingSubtitle() {
    const file = this.pendingUpload();
    const fileId = this.selectedFileId();
    this.pendingUpload.set(null);
    if (!file || !fileId) return;
    await this.subActions.upload(
      this.mediaId(),
      fileId,
      file,
      this.ocrLang(),
      this.subtitles,
      this.subtitleActionBusy,
      this.episodeId(),
    );
    this.toast.success(this.translate.instant('media_detail.upload_subtitle_success'));
  }

  confirmLanguage() {
    const id = this.ocrTargetId();
    this.ocrLangDialog()?.nativeElement.close();
    if (this.langDialogMode() === 'upload') {
      void this.uploadPendingSubtitle();
      return;
    }
    if (id == null) return;
    const mode = this.langDialogMode();
    if (mode === 'ocr') {
      void this.triggerOcr(id, this.ocrLang());
    } else if (mode === 'translate') {
      void this.triggerTranslate(
        id,
        this.ocrLang(),
        this.selectedTranslationProviderId() ?? undefined,
      );
    } else {
      void this.subActions.setLanguage(
        this.mediaId(),
        id,
        this.subtitles,
        this.subtitleActionBusy,
        this.ocrLang(),
      );
    }
  }

  closeOcrLangModal() {
    this.pendingUpload.set(null);
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

  private async triggerTranslate(subtitleId: number, targetLanguage: string, providerId?: number) {
    await this.subActions.translateSubtitle(
      this.mediaId(),
      subtitleId,
      this.subtitles,
      this.subtitleActionBusy,
      targetLanguage,
      providerId,
    );
    this.toast.info(this.translate.instant('media_detail.translation_started'));
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
    await this.subActions.remove(
      this.mediaId(),
      subtitleId,
      this.subtitles,
      this.subtitleActionBusy,
    );
  }
}
