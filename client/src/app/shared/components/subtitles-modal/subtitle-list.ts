import { DestroyRef, computed, effect, inject, untracked, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { formatSubtitleParts } from '../../../core/utils/player.utils';
import { embeddedSubtitleTag, embeddedSubtitleTitle, type SubtitleStreams } from '../../../core/utils/subtitle-tracks';
import { localizeLanguage } from '../../../core/utils/language.utils';
import { isImageBasedSubtitleCodec } from '../../../core/utils/subtitle-codecs';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { SubtitleFileRow, SubtitlesApiService } from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import type { DetailHeroSubtitle } from '../detail-hero/detail-hero';

export interface SubtitleListSource {
  mediaId: () => number;
  fileId: () => number | null;
  /** The file's `streamInfo.subtitles`, for the embedded track titles and tags. */
  streams: () => SubtitleStreams;
  /** Parked in the route cache: no toasts or reloads for events, the list is re-read on return. */
  parked: () => boolean;
}

/** A media's subtitle rows, owned by the detail page so the hero has them before the lazy modal is built. Construct in an injection context. */
export class SubtitleList {
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly subActions = inject(SubtitleActionsService);
  private readonly translate = inject(TranslateService);
  private readonly toast = inject(ToastService);
  private readonly sse = inject(SseService);
  private readonly appSettings = inject(AppSettingsService);

  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly loading = signal(false);

  constructor(readonly src: SubtitleListSource) {}

  private readonly loadEffect = effect(() => {
    if (this.src.mediaId()) untracked(() => void this.load());
  });

  withStreamInfo(sub: SubtitleFileRow) {
    const streams = this.src.streams();
    return { ...sub, title: embeddedSubtitleTitle(sub, streams), languageTag: embeddedSubtitleTag(sub, streams) };
  }

  /** Only the active file's subtitles: a media's other files carry their own. */
  readonly filteredSubtitles = computed(() => {
    const fileId = this.src.fileId();
    return fileId == null ? [] : this.subtitles().filter((s) => s.mediaFileId === fileId);
  });

  /** Localized languages of OCR runs still in progress, surfaced by the detail
   *  page as an "extraction en cours" indicator. */
  readonly ocrInProgress = computed<string[]>(() =>
    this.filteredSubtitles()
      .filter((s) => s.status === 'processing' && s.providerType === 'ocr')
      .map((s) => localizeLanguage(s.language, this.translate)),
  );

  /** Localized languages and live percent of in-progress translation runs, for the detail page's progress bar; `percent` is null until the first batch. */
  readonly translationInProgress = computed<{ language: string; percent: number | null }[]>(() => {
    return this.filteredSubtitles()
      .filter((s) => s.status === 'processing' && s.providerType === 'translated')
      .map((s) => ({
        language: localizeLanguage(s.language, this.translate),
        percent: this.translationPercent(s),
      }));
  });

  /** Percent for a PROCESSING row: the live event, else the server's value at fetch time so a mid-run joiner still sees a bar. */
  translationPercent(sub: SubtitleFileRow): number | null {
    return this.sse.translationProgress()[sub.id] ?? sub.translationProgress ?? null;
  }

  /** Formatted subtitles for the detail hero dropdown */
  readonly headerSubtitles = computed<DetailHeroSubtitle[]>(() => {
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
      const parts = formatSubtitleParts(this.withStreamInfo(s), this.translate, i + 1, labelOpts);
      return {
        id,
        label: parts.sub ? `${parts.head} - ${parts.sub}` : parts.head,
        head: parts.head,
        sub: parts.sub,
        language: s.language,
        languageTag: this.withStreamInfo(s).languageTag,
        forced: s.forced,
        hearingImpaired: s.hearingImpaired,
        image: isImageBasedSubtitleCodec(s.codec),
      };
    });
  });

  private wasParked = false;
  private readonly unparkEffect = effect(() => {
    const parked = this.src.parked();
    if (!parked && this.wasParked) untracked(() => void this.load());
    this.wasParked = parked;
  });

  /** SSE: reload subtitles on sync/download events */
  private readonly subtitleEvents = this.sse
    .on('subtitle.list_changed', 'subtitle.synced', 'subtitle.downloaded', 'subtitle.failed')
    .pipe(takeUntilDestroyed(inject(DestroyRef)))
    .subscribe((event) => {
      const mediaId = this.src.mediaId();
      if (this.src.parked() || !mediaId || (event['mediaId'] as number) !== mediaId) return;

      const automatic = event['automatic'] === true;
      if (event.type === 'subtitle.list_changed') {
        // Carries no outcome to announce: it says the list moved, nothing more.
        void this.load();
      } else if (event.type === 'subtitle.synced') {
        if (!automatic) this.toast.success(this.translate.instant('sse.subtitle_synced'));
        void this.load();
      } else if (event.type === 'subtitle.downloaded') {
        if (!automatic) {
          this.toast.success(
            this.translate.instant(
              event['reason'] === 'translation'
                ? 'sse.subtitle_translated'
                : 'sse.subtitle_downloaded',
              { title: event['title'] ?? '', lang: event['language'] ?? '' },
            ),
          );
        }
        void this.load();
      } else if (event.type === 'subtitle.failed') {
        if (!automatic) {
          const key =
            event['reason'] === 'rate_limit'
              ? event['scope'] === 'daily'
                ? 'media_detail.translation_rate_limited_daily'
                : 'media_detail.translation_rate_limited'
              : event['reason'] === 'translation'
                ? 'sse.translation_failed'
                : 'sse.subtitle_failed';
          this.toast.error(this.translate.instant(key, { lang: event['language'] ?? '' }));
        }
        void this.load();
      }
    });

  async load() {
    const mediaId = this.src.mediaId();
    if (!mediaId) return;
    // Spinner for an empty list only; read untracked so the effects calling this don't depend
    // on the list they are about to replace.
    this.loading.set(untracked(() => this.filteredSubtitles().length === 0));
    void this.subActions.refreshSyncing();
    try {
      this.subtitles.set(await this.subtitlesApi.getForMedia(mediaId, { force: true }));
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
      this.loading.set(false);
    }
  }
}
