import { Component, InjectionToken, computed, effect, inject, Injector, input, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {
  LucideCheck,
  LucideCircleCheck,
  LucideDownload,
  LucideEllipsisVertical,
  LucideHeart,
  LucideListPlus,
  LucidePlay,
  LucideRotateCcw,
} from '@lucide/angular';
import { BrowserDeviceProfileService } from '../../../core/services/browser-device-profile.service';
import { OptimizeModalService } from '../../../core/services/optimize-modal.service';
import { MediaAdminService } from '../../../core/services/media-admin.service';
import type { Media } from '../../../core/services/api/media.service';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { PartyService } from '../../../core/services/party/party.service';
import { PartyApiService } from '../../../core/services/api/party-api.service';
import { StreamingApiService, type PlaybackState } from '../../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../../core/services/offline-playback-sync.service';
import {
  PlayerSettingsService,
  parseRememberedSubtitle,
  type AudioStreamChoice,
} from '../../../core/services/player-settings.service';
import { TrackManagerService, type LaunchTracks } from '../../../core/services/track-manager.service';
import { TvService } from '../../../core/services/tv.service';
import type { DownloadStatus } from '../../../core/services/download-status';
import { AutoDownloadService } from '../../../core/services/auto-download.service';
import { AuthService } from '../../../core/services/auth.service';
import { AddToPlaylistService } from '../../../core/services/add-to-playlist.service';
import { RecommendService } from '../../../core/services/recommend.service';
import { SpoilerService } from '../../../core/services/spoiler.service';
import { AppSettingsService } from '../../../core/services/app-settings.service';
import { CardActionsService, type CardAction } from '../../../core/services/card-actions.service';
import {
  bucketResolutionLabel,
  formatAudioLabel,
  formatAudioParts,
  remainingLabel,
  resolutionFromQualityName,
} from '../../../core/utils/player.utils';
import { normalizeLangTag } from '../../../core/utils/language.utils';
import { hasProviderId } from '../../../core/utils/media-identity';
import { KIND_REGISTRY } from '../../../core/media-kinds';
import type { MediaType } from '../../../core/enums/media-type.enum';
import type { CoreMediaActionId, MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import type { ResolvedMenuRow } from '../../../core/plugin-ui/resolve-menu-contributions';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { MediaActionsController } from '../../utils/media-actions-controller';
import { openMediaMenu } from '../../utils/media-menu';
import { DropdownMenuComponent } from '../dropdown-menu';
import { DropdownOptionComponent } from '../dropdown-option/dropdown-option';
import { HeroBaseComponent, heroDesktopLayout, type HeroChip } from '../hero-base/hero-base';
import { HeroProgressComponent } from '../hero-progress/hero-progress';
import { ProgressBadgeComponent } from '../progress-badge/progress-badge.component';
import { CORE_MEDIA_ACTIONS } from './core-media-actions';

/** What the page that owns the title does for the hero. */
export interface DetailHeroHost {
  openLibrary(): void;
}
export const DETAIL_HERO_HOST = new InjectionToken<DetailHeroHost>('DETAIL_HERO_HOST');

/** A resolved menu row plus the handler the hero binds to it. */
export interface ResolvedMediaAction extends ResolvedMenuRow {
  handler: (() => void) | null;
}

export interface DetailHeroFile {
  id: number;
  quality?: string;
  size?: number;
  streamInfo?: any;
  label?: string;
}

export interface DetailHeroSubtitle {
  id: string;
  label: string;
  head?: string;
  sub?: string;
  language: string;
  languageTag?: string | null;
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Bitmap (PGS/VOBSUB) track. */
  image?: boolean;
}

export interface DetailHeroBadge {
  /** ngx-translate key for the badge text. */
  labelKey: string;
  /** 0–100 progress fill, or null for a plain status chip. */
  percent: number | null;
  /** daisyUI colour class, e.g. `badge-info` / `badge-ghost`. */
  badgeClass: string;
  /** Interpolation for {@link labelKey}, the download count when the chip stands for several. */
  labelParams: Record<string, unknown> | null;
  /** When true the badge renders as a button that emits openDownloadDetail. */
  clickable: boolean;
  /** Spinner before the label, for a state with no percentage of its own. */
  busy: boolean;
}

interface AudioTrack {
  index: number;
  label: string;
  head?: string;
  sub?: string;
  language: string;
}

/** Hero of every detail page: cover or fanart, title, facts, play and track pickers, quick actions and the shared menu.
 *  A kind page supplies what is its own through inputs and the `heroMeta`, `heroActions` and default slots. */
@Component({
  selector: 'app-detail-hero',
  imports: [
    HeroBaseComponent,
    HeroProgressComponent,
    DropdownMenuComponent,
    DropdownOptionComponent,
    ProgressBadgeComponent,
    TvRowDirective,
    TvSelectDirective,
    NgTemplateOutlet,
    FormsModule,
    TranslatePipe,
    LucideCheck,
    LucideCircleCheck,
    LucideDownload,
    LucideEllipsisVertical,
    LucideHeart,
    LucideListPlus,
    LucidePlay,
    LucideRotateCcw,
  ],
  templateUrl: './detail-hero.html',
  host: { class: 'block' },
})
export class DetailHeroComponent {
  protected readonly kinds = KIND_REGISTRY;
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly deviceProfile = inject(BrowserDeviceProfileService);
  private readonly optimizeModal = inject(OptimizeModalService);
  private get playerSettings() {
    return this.injector.get(PlayerSettingsService);
  }
  private get trackManager() {
    return this.injector.get(TrackManagerService);
  }
  private get appSettings() {
    return this.injector.get(AppSettingsService);
  }
  readonly tv = inject(TvService);
  private get autoDownload() {
    return this.injector.get(AutoDownloadService);
  }
  protected readonly desktopLayout = heroDesktopLayout();
  readonly auth = inject(AuthService);
  private get playable() {
    return this.injector.get(PlayableMediaService);
  }
  /** The playback services are fetched on use: a title with no video never builds them. */
  private readonly injector = inject(Injector);
  private get spoilers() {
    return this.injector.get(SpoilerService);
  }
  private get streamingApi() {
    return this.injector.get(StreamingApiService);
  }
  private get offlineSync() {
    return this.injector.get(OfflinePlaybackSyncService);
  }
  private readonly cardActions = inject(CardActionsService);
  private readonly admin = inject(MediaAdminService);
  private readonly playlists = inject(AddToPlaylistService);
  private readonly recommendations = inject(RecommendService);
  private readonly host = inject(DETAIL_HERO_HOST, { optional: true });

  // ── Inputs: content ──
  readonly title = input.required<string>();
  readonly mediaId = input.required<number>();
  readonly mediaType = input.required<MediaType>();
  readonly episodeId = input<number | undefined>(undefined);
  readonly episodeLabel = input<string | null>(null);
  readonly rating = input<number | null>(null);
  readonly dateLabel = input<string | null>(null);
  readonly runtime = input<number | null>(null);
  readonly overview = input<string | null>(null);
  readonly genres = input<string[]>([]);
  /** For series: label of the episode to resume (e.g. "S01:E03 - Title") */
  readonly resumeEpisodeLabel = input<string | null>(null);
  /** For series: resume context (episodeId + mediaFileId) so play() knows what to launch */
  readonly resumeEpisodeId = input<number | undefined>(undefined);
  readonly resumeMediaFileId = input<number | undefined>(undefined);
  readonly status = input<string | null>(null);
  readonly monitored = input(true);
  readonly libraryName = input<string | null>(null);
  readonly qualityProfileName = input<string | null>(null);
  readonly languageProfileName = input<string | null>(null);
  /** Title's original language, keeps the preselected audio label in step with the player's `original` mode. */
  readonly originalLanguage = input<string | null>(null);
  readonly tags = input<string[]>([]);
  /** Reading or listening progress, 0 to 100; null leaves the bar to the resume position of the playback. */
  readonly progress = input<number | null>(null);
  readonly progressText = input<string | null>(null);

  // ── Inputs: images / navigation ──
  /** Landscape art for the mobile hero; without it the mobile hero is the blurred cover with the poster over it. */
  readonly fanartUrl = input<string | null>(null);
  readonly posterUrl = input<string | null>(null);
  readonly posterMode = input<'poster' | 'still'>('poster');
  /** Anti-spoiler: blur the hero and the still until clicked. */
  readonly spoilerImage = input(false);
  /** Anti-spoiler: blur the synopsis until clicked, for a series' episode. A movie's mask comes from its own watched state. */
  readonly spoilerOverview = input(false);
  /** Route the title text links to (e.g. the series, from an episode page). */
  readonly backRoute = input<string[]>(['/']);

  // ── Inputs: subtitles (built by the page from SubtitleFileRow[]) ──
  readonly subtitles = input<DetailHeroSubtitle[]>([]);
  /** Languages of OCR extractions running in the background, shown until each result is ready. */
  readonly ocrLanguages = input<string[]>([]);
  /** Translations running in the background (percent is null before the first batch). */
  readonly translations = input<{ language: string; percent: number | null }[]>([]);

  // ── Inputs: files ──
  readonly files = input<DetailHeroFile[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly multipleFiles = computed(() => this.files().length > 1);

  // ── Inputs: state ──
  /** Viewer already has an open request on this scope; hides the request entry since the backend would refuse a duplicate. */
  readonly userHasOpenWholeRequest = input(false);
  /** Requester without `media.delete` and no pending deletion request. */
  readonly canRequestDeletion = input(false);
  readonly monitoredLoading = input(false);
  readonly deleteLoading = input(false);
  /** Status badge beside the quick actions (download progress); a clickable one emits openDownloadDetail. */
  readonly badge = input<DetailHeroBadge | null>(null);
  /** Cleanup countdown, shown beside the library badge. */
  readonly leavingLabel = input<string | null>(null);
  readonly scopedLeaving = input<string[]>([]);
  /** False when the title has no metadata-provider id; defaults to what `media` says. */
  readonly identified = input<boolean | null>(null);
  /** Download of the file on screen; null when none (a failed one counts as none). */
  readonly download = input<{ status: DownloadStatus; progress: number } | null>(null);
  /** True iff every downloaded episode of non-special seasons is watched; series have no PlaybackState row. */
  readonly seriesFullyWatched = input<boolean>(false);
  /** Whether the viewer likes the title, or the episode on screen. */
  readonly liked = input(false);

  // ── Inputs: menu ──
  /** The full row: enables the shared admin entries (identify, refresh, library, delete). */
  readonly media = input<Media | null>(null);
  /** The page's own menu handlers; they win over the shared ones. */
  readonly actions = input<MediaActionHandlers>({});
  /** Shared entries this kind does not support. */
  readonly exclude = input<CoreMediaActionId[]>([]);

  // ── Outputs ──
  readonly selectedFileIdChange = output<number>();
  readonly openDownload = output<void>();
  /** Open the download-detail modal (per-season breakdown) from the badge. */
  readonly openDownloadDetail = output<void>();
  readonly likeToggled = output<void>();
  /** Emitted after a series-level bulk watched toggle, so the page refreshes its watched list. */
  readonly seriesWatchedToggled = output<{ watched: boolean }>();
  /** Emitted after a single-episode watched toggle so the page can refresh the cards around it. */
  readonly episodeWatchedToggled = output<{ episodeId: number; watched: boolean }>();

  protected readonly viewTransitionName = computed(() =>
    this.episodeId() ? 'media-poster-ep-' + this.episodeId() : 'media-poster-' + this.mediaId(),
  );

  /** `2021 · 42min · Terminé`, joined so the dot only lands between values the provider gave. */
  readonly metaLine = computed(() => {
    const parts: string[] = [];
    const date = this.dateLabel();
    if (date) parts.push(date);
    const runtime = this.runtime();
    if (runtime) parts.push(`${runtime}min`);
    const status = this.statusLabel();
    if (status) parts.push(status);
    return parts.join(' · ');
  });

  /** Translated release status, falling back to the raw provider value. */
  readonly statusLabel = computed(() => {
    const value = this.status();
    if (!value) return '';
    const key = `media_detail.info_status_${value}`;
    const t = this.translate.instant(key);
    return typeof t === 'string' && t !== key ? t : value;
  });

  protected badgeLabel(b: DetailHeroBadge): string {
    return this.translate.instant(b.labelKey, b.labelParams ?? undefined);
  }

  /** A series root marks every episode at once, so it needs no selected file;
   *  a movie or a single episode toggles one file and does need one. */
  readonly canToggleWatched = computed(
    () => (KIND_REGISTRY[this.mediaType()].hasSeasons && !this.episodeId()) || !!this.selectedFileId(),
  );

  // ── Internal state ──

  readonly watched = signal(false);

  protected readonly overviewMasked = computed(() => {
    if (KIND_REGISTRY[this.mediaType()].hasSeasons) return this.spoilerOverview();
    return this.isVideo() && this.spoilers.overview(this.watched());
  });
  readonly resumePositionSeconds = signal<number | null>(null);
  readonly durationSeconds = signal<number | null>(null);
  readonly selectedAudioIndex = signal<number | null>(null);
  readonly selectedSubtitleId = signal<string | null>(null);
  readonly selectedSubtitle = computed(
    () => this.subtitles().find((s) => s.id === this.selectedSubtitleId()) ?? null,
  );

  // ── Load playback state + watched when media/episode changes ──

  /** `mediaId:episodeId` of the last load: Angular reuses the component across episodes, so the identity drops the previous resume state. */
  private lastPlaybackKey: string | null = null;

  private readonly loadPlaybackEffect = effect(() => this.reloadPlaybackState());

  /** Re-read the server's resume position. Cached pages come back with the same
   *  inputs, so the effect alone never fires again after a playback session. */
  reloadPlaybackState(): void {
    const mediaId = this.mediaId();
    if (!this.isVideo()) return;
    // A series page falls back to its resume button's episode, else it would show the media-level position against an episode label.
    const episodeId = this.episodeId() ?? this.resumeEpisodeId();
    if (!mediaId) return;

    const key = `${mediaId}:${episodeId ?? 0}`;
    const switched = key !== this.lastPlaybackKey;
    this.lastPlaybackKey = key;
    if (switched) {
      this.resumePositionSeconds.set(null);
      this.durationSeconds.set(null);
    }

    // A series root toggle marks every episode, so it reads the aggregate `seriesFullyWatched`, keyed on the episode input rather than the resume fallback.
    if (KIND_REGISTRY[this.mediaType()].hasSeasons && !this.episodeId()) {
      this.watched.set(this.seriesFullyWatched());
    } else {
      this.playable.loadWatchedState(mediaId, episodeId).then((v) => {
        // A faster episode switch already superseded this request.
        if (this.lastPlaybackKey === key) this.watched.set(v);
      });
    }

    if (KIND_REGISTRY[this.mediaType()].hasSeasons && !episodeId) {
      // A series' own row is never its resume target; the parent resolves `resumeEpisodeId` shortly and re-runs this.
      return;
    }

    // Tracked read: a position queued offline shows up here as soon as it is
    // recorded, and again as soon as the flush clears it.
    const queued = this.offlineSync.queuedPositionFor(mediaId, episodeId);
    this.applyResume(queued, null);

    // Load resume position
    this.streamingApi.getPlaybackState(mediaId, episodeId).catch(() => null).then(ps => {
      // A faster episode switch already superseded this request.
      if (this.lastPlaybackKey !== key) return;
      // Pre-select last-played file
      if (ps?.mediaFileId && this.files().some(f => f.id === ps.mediaFileId)) {
        this.selectedFileIdChange.emit(ps.mediaFileId);
      }
      this.applyResume(queued, ps);
    });
  }

  /** Show the server's position, unless one queued while the server was out of
   *  reach is still waiting to reach it - that one is newer by construction. */
  private applyResume(
    queued: { positionSeconds: number; durationSeconds: number } | null,
    ps: PlaybackState | null,
  ) {
    const pos = queued?.positionSeconds ?? (ps && !ps.completed ? ps.positionSeconds : 0);
    const dur = queued?.durationSeconds || ps?.durationSeconds || 0;
    if (!pos || pos <= 10) {
      this.resumePositionSeconds.set(null);
      this.durationSeconds.set(null);
      return;
    }
    this.resumePositionSeconds.set(pos);
    this.durationSeconds.set(dur || null);
  }

  // ── Audio/subtitle defaults ──

  readonly audioTracks = computed<AudioTrack[]>(() => {
    const file = this.selectedFile();
    const audio = file?.streamInfo?.audio as any[] | undefined;
    if (!audio?.length) return [];
    const tracks = audio.map((a: any, i: number) => {
      const parts = formatAudioParts(a, this.translate, i + 1);
      return {
        index: i,
        label: formatAudioLabel(a, this.translate, i + 1),
        head: parts.head,
        sub: parts.sub,
        language: a.language ?? 'und',
      };
    });
    return this.appSettings.sortTracks(tracks);
  });

  readonly sortedSubtitles = computed(() =>
    this.appSettings.sortTracks(this.subtitles()),
  );
  readonly selectedAudio = computed(
    () => this.audioTracks().find((t) => t.index === this.selectedAudioIndex()) ?? null,
  );

  private readonly resolveDefaultsEffect = effect(() => {
    const file = this.selectedFile();
    const mediaId = this.mediaId();
    if (!file || !mediaId) return;
    this.picked = {};

    const audio = file.streamInfo?.audio as AudioStreamChoice[] | undefined;
    if (audio?.length) {
      const idx = this.playerSettings.resolveAudioStreamIndex(
        file.id, audio, mediaId, this.originalLanguage(), undefined,
        this.deviceProfile.playableAudioCodecs(),
      );
      this.selectedAudioIndex.set(idx ?? null);
    } else {
      this.selectedAudioIndex.set(null);
    }

    const saved = this.playerSettings.getRememberedSubtitleTrack(mediaId);
    if (saved && saved !== 'off') {
      const { language: lang, forced: wantForced, image: wantImage, hearingImpaired: wantHi, variant } =
        parseRememberedSubtitle(saved);
      const subs = this.subtitles();
      const find = (ok: (s: DetailHeroSubtitle) => boolean) =>
        subs.find(s => ok(s) && s.language === lang && !!s.image === wantImage && !!s.forced === wantForced && !!s.hearingImpaired === wantHi)
        ?? subs.find(s => ok(s) && s.language === lang && !!s.image === wantImage && !!s.forced === wantForced)
        ?? subs.find(s => ok(s) && s.language === lang && !!s.image === wantImage)
        ?? subs.find(s => ok(s) && s.language === lang && !s.forced);
      const match = (variant ? find(s => normalizeLangTag(s.languageTag) === variant) : undefined) ?? find(() => true);
      this.selectedSubtitleId.set(match?.id ?? null);
    } else {
      this.selectedSubtitleId.set(null);
    }
  });

  // ── Actions: play, watched, audio, subtitle ──

  async play(fromStart: boolean) {
    // Series resume: use resume episode context if available
    const resumeFileId = this.resumeMediaFileId();
    const resumeEpId = this.resumeEpisodeId();
    const fileId = resumeFileId ?? this.selectedFileId();
    if (!fileId) return;
    const file = this.files().find(f => f.id === fileId);
    await this.playable.play({
      fileId,
      mediaId: this.mediaId(),
      episodeId: resumeEpId ?? this.episodeId(),
      backdropUrl: this.fanartUrl() ?? this.posterUrl() ?? null,
      streamInfo: file?.streamInfo,
      tracks: this.launchTracks(),
    }, fromStart);
  }

  /** Opens the party dialog on what Play would launch. */
  watchTogether(): void {
    const mediaFileId = this.resumeMediaFileId() ?? this.selectedFileId();
    if (!mediaFileId) return;
    const episodeId = this.resumeEpisodeId() ?? this.episodeId();
    this.injector.get(PartyService).createRequest.set({
      title: this.title(),
      mediaId: this.mediaId(),
      mediaFileId,
      ...(episodeId != null && { episodeId }),
    });
  }

  async onToggleWatched() {
    const mediaId = this.mediaId();
    // Series root toggle: bulk mark every episode as (un)watched.
    if (KIND_REGISTRY[this.mediaType()].hasSeasons && !this.episodeId()) {
      const target = !this.watched();
      try {
        const result = await this.streamingApi.toggleSeriesWatched(mediaId, target);
        this.watched.set(result.watched);
        this.seriesWatchedToggled.emit(result);
      } catch { /* ignore */ }
      return;
    }

    // Single movie / episode toggle - existing per-file behavior.
    const fileId = this.selectedFileId();
    if (!fileId) return;
    try {
      const episodeId = this.episodeId();
      const completed = await this.playable.toggleWatched(
        mediaId,
        fileId,
        episodeId,
      );
      this.watched.set(completed);
      // Backend resets positionSeconds to 0 when marking as watched - mirror
      // that locally so the resume bar disappears without a page reload.
      if (completed) {
        this.resumePositionSeconds.set(null);
        this.durationSeconds.set(null);
      }
      if (episodeId) {
        this.episodeWatchedToggled.emit({ episodeId, watched: completed });
      }
    } catch { /* ignore */ }
  }

  /** The pickers' explicit choices on the selected file, which the player honours with
   *  or without the remembered store. Defaults the header resolves are not choices. */
  private picked: Omit<LaunchTracks, 'fileId'> = {};

  private launchTracks(): LaunchTracks | undefined {
    const fileId = this.selectedFile()?.id;
    return fileId != null && Object.keys(this.picked).length ? { fileId, ...this.picked } : undefined;
  }

  onAudioChange(index: number) {
    this.picked = { ...this.picked, audioStreamIndex: index };
    this.selectedAudioIndex.set(index);
    const streams = (this.selectedFile()?.streamInfo?.audio ?? []) as AudioStreamChoice[];
    this.trackManager.saveAudioSelection(
      `audio-${index}`,
      streams.map((s, i) => ({ ...s, id: `audio-${i}` })),
      this.mediaId(),
    );
  }

  onSubtitleChange(id: string | null) {
    this.picked = { ...this.picked, subtitleId: id };
    this.selectedSubtitleId.set(id);
    const mediaId = this.mediaId();
    if (!id) {
      this.trackManager.saveSubtitleSelection(mediaId, null);
    } else {
      const sub = this.subtitles().find(s => s.id === id);
      if (sub) this.trackManager.saveSubtitleSelection(mediaId, sub.language, sub.forced, sub.id.startsWith('emb-'), sub.image, sub.hearingImpaired, sub.languageTag);
    }
  }

  // ── Computed display values ──

  readonly videoLabel = computed(() => {
    const file = this.selectedFile();
    if (!file?.streamInfo?.video?.[0]) return null;
    const v = file.streamInfo.video[0];
    const parts: string[] = [];
    // Prefer the stored parsed quality (backend resolveQuality handles letterbox crops); bucket by dimensions for files imported before it existed.
    const res =
      resolutionFromQualityName(file.quality) ??
      bucketResolutionLabel(v.width, v.height);
    if (res) parts.push(res);
    if (v.hdrFormat) parts.push(v.hdrFormat);
    else if (v.colorTransfer === 'smpte2084') parts.push('HDR10');
    else if (v.colorTransfer === 'arib-std-b67') parts.push('HLG');
    if (v.colorSpace === 'bt2020nc' && !parts.some((p: string) => p.startsWith('HDR') || p === 'HLG')) {
      parts.push('HDR');
    }
    if (v.profile?.toLowerCase().includes('dolby') || v.codec?.toLowerCase().includes('dolby')) {
      const idx = parts.findIndex((p: string) => p.startsWith('HDR'));
      if (idx >= 0) parts[idx] = 'Dolby Vision';
      else parts.push('Dolby Vision');
    }
    const codec = v.codec?.toUpperCase()?.replace('H264', 'H.264')?.replace('H265', 'HEVC') ?? '';
    if (codec) parts.push(codec);
    return parts.join(' ') || null;
  });

  readonly resumeLabel = computed(() => {
    const pos = this.resumePositionSeconds();
    if (!pos || pos <= 10) return null;
    const s = Math.floor(pos);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  });

  readonly progressPercent = computed(() => {
    const pos = this.resumePositionSeconds();
    const dur = this.durationSeconds();
    if (!pos || !dur) return 0;
    return Math.min(100, (pos / dur) * 100);
  });

  readonly remainingLabel = computed(() => {
    const pos = this.resumePositionSeconds();
    const dur = this.durationSeconds();
    return pos && dur ? remainingLabel(dur - pos, this.translate) : null;
  });

  readonly endTimeLabel = computed(() => {
    const dur = this.durationSeconds();
    const pos = this.resumePositionSeconds();
    if (!dur) return null;
    const remaining = dur - (pos ?? 0);
    const end = new Date(Date.now() + remaining * 1000);
    const hh = String(end.getHours()).padStart(2, '0');
    const mm = String(end.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  });

  readonly selectedFile = computed(() => {
    const id = this.selectedFileId();
    return this.files().find(f => f.id === id) ?? this.files()[0] ?? null;
  });

  fileLabel(f: DetailHeroFile): string {
    if (f.label) return f.label;
    return f.quality || `#${f.id}`;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1_000_000) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1_000_000_000) return `${(bytes / 1_048_576).toFixed(1)} MB`;
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }

  navigateToGenre(genre: string) {
    const library = this.libraryName();
    if (!library) return;
    void this.router.navigate(['/libraries', library], { queryParams: { genre } });
  }

  // ── The bar under the actions ──

  /** The reading or listening progress a page hands over, else the playback's resume position. */
  protected readonly barPercent = computed(() => this.progress() ?? this.progressPercent());
  protected readonly barLabel = computed(() => (this.progress() != null ? this.progressText() : this.remainingLabel()));
  protected readonly showBar = computed(() => this.progress() != null || (!!this.resumeLabel() && this.progressPercent() > 0));

  /** The facts of the meta row: the date, runtime and status line, and when it ends on a desktop. */
  protected readonly metaParts = computed(() => {
    const ends = this.desktopLayout() && this.selectedFileId() ? this.endTimeLabel() : null;
    return [this.metaLine(), ends ? this.translate.instant('media_info.ends_at', { time: ends }) : ''].filter(Boolean);
  });

  protected readonly chips = computed<HeroChip[]>(() => {
    const desktop = this.desktopLayout();
    const chips: HeroChip[] = [];
    if (desktop && !this.monitored()) {
      chips.push({ label: 'media_detail.unmonitored', cls: 'hidden lg:inline-flex badge badge-ghost' });
    }
    if (this.libraryName()) chips.push({ label: this.libraryName()!, cls: 'badge badge-primary badge-outline' });
    if (this.leavingLabel()) chips.push({ label: this.leavingLabel()!, cls: 'badge badge-warning' });
    if (!desktop) for (const label of this.scopedLeaving()) chips.push({ label, cls: 'badge badge-warning' });
    return chips;
  });

  // ── Playlist, recommendation, library ──

  private readonly isVideo = computed(() => KIND_REGISTRY[this.mediaType()].families.includes('video'));

  protected addToPlaylist(): void {
    const episodeId = this.episodeId();
    this.playlists.open(episodeId ? { episodeId } : { mediaId: this.mediaId() });
  }

  private recommend(): void {
    const episodeId = this.episodeId();
    this.recommendations.open(episodeId ? { mediaId: this.mediaId(), episodeId } : { mediaId: this.mediaId() });
  }

  private readonly identifiedTitle = computed(() => {
    const given = this.identified();
    if (given != null) return given;
    const m = this.media();
    return !m || hasProviderId(m) || !!m.providers?.length || !!m.externalIds?.length;
  });

  // ── media.actions: the kebab menu, rendered from the contribution registry ──

  /** Visibility the `when` vocabulary can't express (an OR, or non-permission facts); only narrows, for a few ids. */
  private get partyApi() {
    return this.injector.get(PartyApiService);
  }
  private readonly extraGuards: Record<string, () => boolean> = {
    'core.recommend': () => !this.auth.sharingDisabled(),
    'core.watch_together': () => this.partyApi.canCreate(),
    'core.download': () => !this.download() || this.download()?.status === 'ready',
    'core.download_series': () => !this.episodeId() && this.files().length > 0,
    'core.auto_download_group': () => this.autoDownload.enabled && !this.episodeId(),
    'core.request_media': () => {
      const needsFile = !KIND_REGISTRY[this.mediaType()].hasSeasons || !!this.episodeId();
      return !this.userHasOpenWholeRequest() && (!needsFile || !this.selectedFileId());
    },
    // Pending deletion request is per-title async state fetched by the page, not a permission.
    'core.request_deletion': () => this.canRequestDeletion(),
  };

  private readonly handlers = computed<MediaActionHandlers>(() => {
    const m = this.media();
    const shared: MediaActionHandlers = {
      'media.toggle-like': () => this.likeToggled.emit(),
      'media.add-to-playlist': () => this.addToPlaylist(),
      'media.recommend': () => this.recommend(),
      ...(m && {
        'media.identify': () => this.admin.identify(m),
        'media.refresh-metadata': () => void this.admin.refreshMetadata(m.id),
        'media.edit-library': () => this.host?.openLibrary(),
        'media.delete': () => void this.admin.deleteMedia(m),
      }),
      ...(m && this.isVideo() && {
        'media.optimize': () => this.optimizeModal.open({
          title: m.title,
          mediaIds: [m.id],
          episodeIds: this.episodeId() ? [this.episodeId()!] : undefined,
        }),
      }),
      ...(this.isVideo() && {
        'media.download': () => this.openDownload.emit(),
        'media.auto-download-0': () => this.autoDownload.setSeriesKeep(this.mediaId(), null),
        'media.auto-download-3': () => this.autoDownload.setSeriesKeep(this.mediaId(), 3),
        'media.auto-download-5': () => this.autoDownload.setSeriesKeep(this.mediaId(), 5),
        'media.auto-download-10': () => this.autoDownload.setSeriesKeep(this.mediaId(), 10),
        'media.toggle-series-watched': () => this.onToggleWatched(),
        'media.toggle-watched': () => this.onToggleWatched(),
        'media.watch-together': () => this.watchTogether(),
      }),
    };
    for (const id of this.exclude()) delete shared[id];
    return { ...shared, ...this.actions() };
  });

  /** The when-context, the acquisition handlers and the contribution merge, shared with every other detail header. */
  private readonly actionsMenu = new MediaActionsController({
    base: () => ({
      mediaId: this.mediaId(),
      kind: this.mediaType(),
      level: this.episodeId() ? 'item' : 'work',
      itemId: this.episodeId(),
    }),
    facts: () => ({
      isAdmin: this.auth.hasPermission('settings.access'),
      hasFiles: !!this.selectedFileId(),
      isMonitored: this.monitored(),
      identified: this.identifiedTitle(),
    }),
    core: CORE_MEDIA_ACTIONS,
    handlers: () => this.handlers(),
    guards: this.extraGuards,
  });

  readonly menuItems = computed<ResolvedMediaAction[]>(() => this.actionsMenu.rows().map((r) => ({ ...r, handler: r.run })));

  /** A few rows swap their label by live state (watched, monitored), cosmetic and so kept out of the static contribution. */
  displayLabelKey(item: ResolvedMediaAction): string {
    if (item.actionId === 'media.toggle-series-watched') {
      return this.watched() ? 'media_detail.mark_series_unwatched' : 'media_detail.mark_series_watched';
    }
    if (item.actionId === 'media.toggle-monitored') {
      return this.monitored() ? 'media_detail.unmonitor' : 'media_detail.monitor';
    }
    if (item.actionId === 'media.toggle-watched') {
      return this.watched() ? 'media_card.mark_unwatched' : 'media_card.mark_watched';
    }
    if (item.actionId === 'media.download' && this.download()) return 'downloads.change_quality';
    if (item.actionId === 'media.toggle-like') {
      return this.liked() ? 'media_detail.unlike' : 'media_detail.like';
    }
    // A book's profiles are its wanted formats and languages.
    if (item.actionId === 'media.edit-profiles' && this.mediaType() === 'book') return 'books_work.edit_profiles';
    return item.labelKey;
  }

  /** The one row whose icon shape (not just tint) follows live state. */
  displayIcon(item: ResolvedMediaAction): string {
    const keep = this.autoKeepOf(item);
    if (keep !== null) return keep === (this.autoDownload.seriesKeep(this.mediaId()) ?? 0) ? 'check' : item.icon;
    if (item.actionId === 'media.toggle-monitored') {
      return this.monitored() ? 'eye-off' : 'eye';
    }
    if (item.actionId === 'media.toggle-watched') {
      return this.watched() ? 'eye-off' : 'eye';
    }
    return item.icon;
  }

  /** Hands the rows to the shared card actions panel anchored to the clicked button; the panel owns the chrome per form factor. */
  openActionsMenu(anchor: HTMLElement) {
    openMediaMenu(
      this.cardActions,
      this.menuItems(),
      anchor,
      {
        title: this.title(),
        subtitle: this.dateLabel() ?? '',
        imageUrl: this.posterUrl(),
        imageAspect: this.episodeId() ? 'landscape' : 'portrait',
      },
      (r) => this.rowOverrides(r as ResolvedMediaAction),
    );
  }

  private autoKeepOf(item: ResolvedMediaAction): number | null {
    const m = item.actionId?.match(/^media\.auto-download-(\d+)$/);
    return m ? Number(m[1]) : null;
  }

  private rowOverrides(item: ResolvedMediaAction): Partial<CardAction> {
    const keep = this.autoKeepOf(item);
    return {
      ...(keep
        ? { labelKey: undefined, label: this.translate.instant('downloads.auto_next', { count: keep }) }
        : { labelKey: this.displayLabelKey(item) }),
      icon: this.displayIcon(item),
      disabled: this.isItemDisabled(item),
    };
  }

  /** Mid-request spinner, per actionId - the ids not listed never show one. */
  isItemBusy(item: ResolvedMediaAction): boolean {
    if (item.actionId === 'media.delete') return this.deleteLoading();
    return this.actionsMenu.isBusy(item.actionId);
  }

  /** Disabled state, per actionId - the ids not listed are never disabled. */
  isItemDisabled(item: ResolvedMediaAction): boolean {
    if (item.actionId === 'media.toggle-monitored') return this.monitoredLoading();
    if (item.actionId === 'media.delete') return this.deleteLoading();
    return this.actionsMenu.isDisabled(item.actionId);
  }
}
