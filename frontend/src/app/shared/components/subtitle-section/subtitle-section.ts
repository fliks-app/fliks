import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import {
  SubtitlesApiService,
  SubtitleFileRow,
  SubtitleSearchResult,
} from '../../../core/services/api/subtitles-api.service';
import { SubtitleActionsService } from '../../../core/services/subtitle-actions.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ProfilesService, LanguageProfile } from '../../../core/services/api/profiles.service';
import { SseService } from '../../../core/services/sse.service';
import { ToastService } from '../../../core/services/toast.service';
import { MediaDetailSubtitlesComponent } from '../../../features/media-detail/components/media-detail-subtitles/media-detail-subtitles.component';
import { MediaDetailSubtitleSearchModalComponent } from '../../../features/media-detail/components/media-detail-subtitle-search-modal/media-detail-subtitle-search-modal.component';
import type { MediaInfoHeaderSubtitle } from '../media-info-header/media-info-header';

/**
 * Self-contained subtitle section: loads, displays, searches, and manages subtitles.
 * Used by both media-detail (movies) and episode-detail pages.
 */
@Component({
  selector: 'app-subtitle-section',
  imports: [MediaDetailSubtitlesComponent, MediaDetailSubtitleSearchModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitle-section.html',
})
export class SubtitleSectionComponent {
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

  // ── Internal state ──
  readonly subtitles = signal<SubtitleFileRow[]>([]);
  readonly subtitlesLoading = signal(false);
  readonly subtitleActionBusy = signal(false);
  readonly subSearchLang = signal('en');
  readonly subSearchResults = signal<SubtitleSearchResult[]>([]);
  readonly subSearchLoading = signal(false);
  readonly subSearchSearched = signal(false);
  private readonly languageProfiles = signal<LanguageProfile[]>([]);

  private readonly searchModal = viewChild(MediaDetailSubtitleSearchModalComponent);

  // ── Computed ──

  /** Subtitles filtered for the current episode (if set) */
  private readonly episodeSubtitles = computed(() => {
    const epId = this.episodeId();
    const all = this.subtitles();
    if (!epId) return all;
    const fileIds = new Set(
      this.files()
        .filter(f => f.episodeId != null && Number(f.episodeId) === epId)
        .map(f => f.id),
    );
    return all.filter(s => s.episodeId === epId || fileIds.has(s.mediaFileId));
  });

  /** Subtitles filtered by selected file when multiple files exist */
  readonly filteredSubtitles = computed(() => {
    const all = this.episodeSubtitles();
    const fileId = this.selectedFileId();
    const files = this.files();
    if (!fileId || files.length <= 1) return all;
    return all.filter(s => s.mediaFileId === fileId);
  });

  /** Required subtitle languages from language profile */
  readonly requiredSubtitleLangs = computed(() => {
    const lpId = this.languageProfileId();
    if (!lpId) return [];
    const lp = this.languageProfiles().find(p => p.id === lpId);
    return lp?.subtitleLanguages ?? [];
  });

  /** Formatted subtitles for the media-info-header dropdown */
  readonly headerSubtitles = computed<MediaInfoHeaderSubtitle[]>(() => {
    const subs = this.filteredSubtitles();
    return subs.map(s => {
      const fmt = s.codec?.replace('hdmv_pgs_subtitle', 'PGS')
                         .replace('subrip', 'SRT')
                         .replace('ass', 'ASS')
                         .replace('webvtt', 'VTT')
                         .toUpperCase() ?? (s.relativePath ? 'SRT' : 'EMB');
      const id = s.streamIndex != null ? `emb-${s.streamIndex}` : `ext-${s.id}`;
      return {
        id,
        label: `${s.language}${s.forced ? ' (Forced)' : ''} (${fmt})`,
        language: s.language,
        forced: s.forced,
      };
    });
  });

  // ── Auto-load subtitles when mediaId changes ──

  private lastSseEvent: any = null;

  private readonly loadEffect = effect(() => {
    const mediaId = this.mediaId();
    if (mediaId) void this.loadSubtitles(mediaId);
  });

  private readonly loadProfilesEffect = effect(() => {
    const lpId = this.languageProfileId();
    if (lpId && !this.languageProfiles().length) {
      this.profilesApi.getLanguageProfiles().then(lp => this.languageProfiles.set(lp)).catch(() => {});
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
      this.mediaId(), fileId, this.subSearchLang(),
      this.subtitles, this.subtitleActionBusy, this.episodeId(),
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
        this.mediaId(), this.subSearchLang(), this.episodeId(),
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
      this.mediaId(), fileId, r,
      this.subtitles, this.subtitleActionBusy, this.episodeId(),
    );
  }

  async syncSubtitle(event: { subtitleId: number; options: any }) {
    await this.subActions.sync(this.mediaId(), event.subtitleId, event.options);
  }

  async postProcessSubtitle(event: { subtitleId: number; action: string; params?: Record<string, unknown> }) {
    await this.subActions.postProcess(this.mediaId(), event.subtitleId, event.action, event.params);
    await this.loadSubtitles(this.mediaId());
  }

  async blacklistSubtitle(sub: SubtitleFileRow) {
    await this.subActions.blacklist(this.mediaId(), sub, this.subtitles);
  }

  async deleteSubtitle(subtitleId: number) {
    if (!await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('media_detail.confirm_delete_subtitle'),
      variant: 'danger',
    })) return;
    await this.subActions.remove(this.mediaId(), subtitleId, this.subtitles, this.subtitleActionBusy);
  }
}
