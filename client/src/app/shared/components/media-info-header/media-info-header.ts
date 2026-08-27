import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {
  LucideCaptions,
  LucideCheck,
  LucideCircle,
  LucideClipboardList,
  LucideDownload,
  LucideEllipsisVertical,
  LucideEye,
  LucideEyeOff,
  LucideFilm,
  LucideFolder,
  LucideHeart,
  LucideListChecks,
  LucideListPlus,
  LucidePlay,
  LucideRotateCcw,
  LucideScanLine,
  LucideSearch,
  LucideSettings,
  LucideTrash2,
  LucideUserPlus,
} from '@lucide/angular';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import {
  StreamingApiService,
  type PlaybackState,
} from '../../../core/services/api/streaming-api.service';
import { OfflinePlaybackSyncService } from '../../../core/services/offline-playback-sync.service';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { TrackManagerService } from '../../../core/services/track-manager.service';
import { NavbarService } from '../../../core/services/navbar.service';
import { TvService } from '../../../core/services/tv.service';
import { DeviceService } from '../../../core/services/device.service';
import { AuthService } from '../../../core/services/auth.service';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import {
  bucketResolutionLabel,
  formatAudioLabel,
  formatAudioParts,
  resolutionFromQualityName,
} from '../../../core/utils/player.utils';
import { DropdownMenuComponent } from '../dropdown-menu';
import { DropdownOptionComponent } from '../dropdown-option/dropdown-option';
import { ProgressBadgeComponent } from '../progress-badge/progress-badge.component';
import { ImgFadeInDirective } from '../../directives/img-fade-in.directive';
import { ClampToggleDirective } from '../../directives/clamp-toggle.directive';
import { TvRowDirective } from '../../directives/tv-row.directive';
import { TvSelectDirective } from '../../directives/tv-select.directive';
import { NgTemplateOutlet } from '@angular/common';
import { PluginUiRegistryService } from '../../../core/plugin-ui/plugin-ui-registry.service';
import { evaluateWhen, type WhenContext } from '../../../core/plugin-ui/when-evaluator';
import type { MediaType } from '../../../core/enums/media-type.enum';
import { resolveMediaAction, type MediaActionHandlers } from '../../../core/plugin-ui/media-action-registry';
import { CORE_MEDIA_ACTIONS } from './core-media-actions';
import type { UiContribution } from '@fliks/plugin-contract/ui';
import { CachedSrcDirective } from '../../directives/cached-src.directive';

/** One `media.actions` contribution resolved to something the template can
 *  render directly — visibility, handler and icon fallback already decided. */
export interface ResolvedMediaAction {
  id: string;
  labelKey: string;
  icon: string;
  tone: 'default' | 'danger';
  confirmKey?: string;
  actionId?: string;
  route?: string;
  handler: (() => void) | null;
}

export interface MediaInfoHeaderFile {
  id: number;
  quality?: string;
  size?: number;
  streamInfo?: any;
  label?: string;
}

export interface MediaInfoHeaderSubtitle {
  id: string;
  label: string;
  head?: string;
  sub?: string;
  language: string;
  forced?: boolean;
  /** Bitmap (PGS/VOBSUB) track. */
  image?: boolean;
}

export interface MediaInfoHeaderBadge {
  /** ngx-translate key for the badge text. */
  labelKey: string;
  /** 0–100 progress fill, or null for a plain status chip. */
  percent: number | null;
  /** daisyUI colour class, e.g. `badge-info` / `badge-ghost`. */
  badgeClass: string;
  /** When true the badge renders as a button that emits openDownloadDetail. */
  clickable: boolean;
}

interface AudioTrack {
  index: number;
  label: string;
  head?: string;
  sub?: string;
  language: string;
}

@Component({
  selector: 'app-media-info-header',
  imports: [
    CachedSrcDirective,
    MobileFanartHeroComponent,
    ResolveUrlPipe,
    DropdownMenuComponent, DropdownOptionComponent,
    ProgressBadgeComponent,
    ImgFadeInDirective,
    ClampToggleDirective,
    TvRowDirective,
    TvSelectDirective,
    NgTemplateOutlet,
    DecimalPipe, FormsModule, RouterLink, TranslateModule,
    LucideCaptions, LucideCheck, LucideCircle, LucideClipboardList, LucideDownload,
    LucideEllipsisVertical, LucideEye, LucideEyeOff,
    LucideFilm, LucideFolder, LucideHeart, LucideListChecks, LucideListPlus, LucidePlay, LucideRotateCcw, LucideScanLine,
    LucideSearch, LucideSettings, LucideTrash2, LucideUserPlus,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-info-header.html',
})
export class MediaInfoHeaderComponent {
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  readonly navbar = inject(NavbarService);
  readonly tv = inject(TvService);
  private readonly device = inject(DeviceService);
  readonly auth = inject(AuthService);
  private readonly playable = inject(PlayableMediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  private readonly pluginUi = inject(PluginUiRegistryService);

  // ── Inputs: content ──
  readonly title = input.required<string>();
  readonly mediaId = input.required<number>();
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

  /**
   * `2021 · 42min · Terminé`. Joined rather than separated in the template so
   * the dot only lands between values the provider actually gave.
   */
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
  readonly monitored = input(true);
  readonly libraryName = input<string | null>(null);
  readonly qualityProfileName = input<string | null>(null);
  readonly languageProfileName = input<string | null>(null);
  readonly tags = input<string[]>([]);

  // ── Inputs: images / navigation ──
  readonly fanartUrl = input<string | null>(null);
  readonly posterUrl = input<string | null>(null);
  readonly posterMode = input<'poster' | 'still'>('poster');
  /** Route the title text links to (e.g. the series, from an episode page). */
  readonly backRoute = input<string[]>(['/']);

  // ── Inputs: subtitles (built by parent from SubtitleFileRow[]) ──
  readonly subtitles = input<MediaInfoHeaderSubtitle[]>([]);
  /** Localized languages of OCR extractions running in the background, shown
   *  as an "extraction en cours" indicator until each result is ready. */
  readonly ocrLanguages = input<string[]>([]);
  /** Translations running in the background, shown as a "traduction en cours"
   *  progress bar until each is ready (percent is null before the first batch). */
  readonly translations = input<{ language: string; percent: number | null }[]>([]);

  // ── Inputs: files ──
  readonly files = input<MediaInfoHeaderFile[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly multipleFiles = computed(() => this.files().length > 1);

  // ── Inputs: permissions / loading ──
  readonly canEditProfiles = input(false);
  readonly canDelete = input(false);
  readonly isAdmin = input(false);
  /** Viewer can submit a request (regular requester role). Surfaces the
   *  Demander entry in the More dropdown when the item is missing. */
  readonly canRequest = input(false);
  /** Viewer already has an active request on the current scope (movie
   *  for movies / whole-series for series). When true the Demander
   *  entry is hidden — the backend would refuse the duplicate anyway. */
  readonly userHasOpenWholeRequest = input(false);
  /** Viewer can ask an admin to delete this title from the library (a
   *  requester without the direct `media.delete` permission, with no pending
   *  deletion request already on the title). Surfaces the deletion entry in
   *  the More dropdown. */
  readonly canRequestDeletion = input(false);
  readonly releasesLoading = input(false);
  readonly grabBusy = input<string | null>(null);
  readonly monitoredLoading = input(false);
  readonly deleteLoading = input(false);
  /** Status badge rendered next to the kebab menu (download progress, or the
   *  monitored state), or null to show none. A clickable badge emits
   *  openDownloadDetail. */
  readonly badge = input<MediaInfoHeaderBadge | null>(null);

  // ── Inputs: series-specific ──
  readonly mediaType = input<string>('movie');
  readonly episodeStats = input<{ downloadedEpisodes: number; totalEpisodes: number } | null>(null);
  /**
   * Derived watched status for a series (true iff every downloaded episode in a
   * non-special season is marked as watched). Used instead of a series-level
   * PlaybackState row, which does not exist for series.
   */
  readonly seriesFullyWatched = input<boolean>(false);

  // ── Outputs (delegated to parent) ──
  readonly selectedFileIdChange = output<number>();
  readonly openDownload = output<void>();
  readonly openProfiles = output<void>();
  readonly openLibrary = output<void>();
  readonly refreshMetadata = output<void>();
  readonly toggleMonitored = output<void>();
  readonly deleteMedia = output<void>();
  readonly loadReleases = output<void>();
  readonly grabBest = output<void>();
  readonly identify = output<void>();
  readonly openAnalyze = output<void>();
  readonly editSubtitles = output<void>();
  /** Open the tracking-status modal scoped to this header's context
   *  (whole series / the movie / the current episode). */
  readonly openTracking = output<void>();
  /** Open the download-detail modal (per-season breakdown) from the header
   *  download badge. */
  readonly openDownloadDetail = output<void>();
  /** Viewer (regular requester) asks to (re-)request the current title. */
  readonly requestMedia = output<void>();
  /** Viewer (regular requester) asks an admin to delete this title. */
  readonly requestDeletion = output<void>();
  /** Viewer wants to add the current title to one of their playlists. */
  readonly addToPlaylist = output<void>();
  /** Viewer wants to recommend the current title to another member. */
  readonly recommend = output<void>();
  /** Whether the viewer likes the current movie / episode. */
  readonly liked = input(false);
  /** Toggle the like on the current movie / episode. */
  readonly likeToggled = output<void>();
  /** Emitted after a series-level bulk watched toggle. Parent should refresh its episode watched list. */
  readonly seriesWatchedToggled = output<{ watched: boolean }>();
  /** Emitted after a single-episode watched toggle so the parent can refresh
   *  watched/progress state on the surrounding scroller cards. */
  readonly episodeWatchedToggled = output<{ episodeId: number; watched: boolean }>();

  // ── Internal state ──

  readonly watched = signal(false);
  readonly resumePositionSeconds = signal<number | null>(null);
  readonly durationSeconds = signal<number | null>(null);
  readonly selectedAudioIndex = signal<number | null>(null);
  readonly selectedSubtitleId = signal<string | null>(null);
  readonly selectedSubtitle = computed(
    () => this.subtitles().find((s) => s.id === this.selectedSubtitleId()) ?? null,
  );

  // ── Load playback state + watched when media/episode changes ──

  /** `mediaId:episodeId` of the last playback-state load. Angular reuses this
   *  component between two episodes of the same show, so the identity has to
   *  be tracked to drop the previous episode's resume state. */
  private lastPlaybackKey: string | null = null;

  private readonly loadPlaybackEffect = effect(() => {
    const mediaId = this.mediaId();
    // A series page has no episode context of its own, but it does know which
    // episode its resume button targets. Without this fallback it asked for the
    // media-level row (episode IS NULL) and showed that position against an
    // episode-specific label.
    const episodeId = this.episodeId() ?? this.resumeEpisodeId();
    if (!mediaId) return;

    const key = `${mediaId}:${episodeId ?? 0}`;
    const switched = key !== this.lastPlaybackKey;
    this.lastPlaybackKey = key;
    if (switched) {
      this.resumePositionSeconds.set(null);
      this.durationSeconds.set(null);
    }


    // Watched state: for a series without an episode context, derive from the
    // aggregate `seriesFullyWatched` input (see parent). Otherwise, read the
    // playback_state row as before.
    if (this.mediaType() === 'series' && !episodeId) {
      this.watched.set(this.seriesFullyWatched());
    } else {
      this.playable.loadWatchedState(mediaId, episodeId).then(v => this.watched.set(v));
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
  });

  /** Show the server's position, unless one queued while the server was out of
   *  reach is still waiting to reach it — that one is newer by construction. */
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
    return audio.map((a: any, i: number) => {
      const parts = formatAudioParts(a, this.translate, i + 1);
      return {
        index: i,
        label: formatAudioLabel(a, this.translate, i + 1),
        head: parts.head,
        sub: parts.sub,
        language: a.language ?? 'und',
      };
    });
  });
  readonly selectedAudio = computed(
    () => this.audioTracks().find((t) => t.index === this.selectedAudioIndex()) ?? null,
  );

  private readonly resolveDefaultsEffect = effect(() => {
    const file = this.selectedFile();
    const mediaId = this.mediaId();
    if (!file || !mediaId) return;

    const audio = file.streamInfo?.audio as { language?: string }[] | undefined;
    if (audio?.length) {
      const idx = this.playerSettings.resolveAudioStreamIndex(file.id, audio, mediaId);
      this.selectedAudioIndex.set(idx ?? null);
    } else {
      this.selectedAudioIndex.set(null);
    }

    const saved = this.playerSettings.getRememberedSubtitleTrack(mediaId);
    if (saved && saved !== 'off') {
      const parts = saved.split(':');
      const lang = parts[0];
      const wantForced = parts.includes('forced');
      const wantImage = parts.includes('image');
      const subs = this.subtitles();
      const match =
        subs.find(s => s.language === lang && !!s.image === wantImage && !!s.forced === wantForced)
        ?? subs.find(s => s.language === lang && !!s.image === wantImage)
        ?? subs.find(s => s.language === lang && !s.forced);
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
      title: this.title(),
      episodeTitle: this.resumeEpisodeLabel() ?? this.episodeLabel() ?? undefined,
      fanartUrl: this.posterUrl() ?? this.fanartUrl() ?? null,
      streamInfo: file?.streamInfo,
    }, fromStart);
  }

  async onToggleWatched() {
    const mediaId = this.mediaId();
    // Series root toggle: bulk mark every episode as (un)watched.
    if (this.mediaType() === 'series' && !this.episodeId()) {
      const target = !this.watched();
      try {
        const result = await this.streamingApi.toggleSeriesWatched(mediaId, target);
        this.watched.set(result.watched);
        this.seriesWatchedToggled.emit(result);
      } catch { /* ignore */ }
      return;
    }

    // Single movie / episode toggle — existing per-file behavior.
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
      // Backend resets positionSeconds to 0 when marking as watched — mirror
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

  onAudioChange(index: number) {
    this.selectedAudioIndex.set(index);
    const tracks = this.audioTracks();
    this.trackManager.saveAudioSelection(
      `audio-${index}`,
      tracks.map(t => ({ id: `audio-${t.index}`, language: t.language })),
      this.mediaId(),
      0,
    );
  }

  onSubtitleChange(id: string | null) {
    this.selectedSubtitleId.set(id);
    const mediaId = this.mediaId();
    if (!id) {
      this.trackManager.saveSubtitleSelection(mediaId, null);
    } else {
      const sub = this.subtitles().find(s => s.id === id);
      if (sub) this.trackManager.saveSubtitleSelection(mediaId, sub.language, sub.forced, sub.id.startsWith('emb-'), sub.image);
    }
  }

  // ── Computed display values ──

  readonly videoLabel = computed(() => {
    const file = this.selectedFile();
    if (!file?.streamInfo?.video?.[0]) return null;
    const v = file.streamInfo.video[0];
    const parts: string[] = [];
    // Prefer the parsed quality stored on the file — the backend's
    // resolveQuality already handles letterbox crops correctly using
    // ceilings on both axes. Fall back to dimension bucketing for
    // files imported before the quality was parsed.
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
    if (!pos || !dur || dur <= pos) return null;
    const rem = Math.floor(dur - pos);
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    if (h > 0) return `${h}h${String(m).padStart(2, '0')} ${this.translate.instant('media_info.remaining')}`;
    return `${m}min ${this.translate.instant('media_info.remaining')}`;
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

  fileLabel(f: MediaInfoHeaderFile): string {
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

  // ── media.actions: the kebab menu, rendered from the contribution registry ──

  private readonly mediaActionsContext = computed<WhenContext>(() => ({
    isAdmin: this.isAdmin(),
    hasPermission: (p: string) => this.auth.hasPermission(p),
    mediaType: this.mediaType() as MediaType,
    hasFiles: !!this.selectedFileId(),
    isMonitored: this.monitored(),
    hasQualityProfile: !!this.qualityProfileName(),
    isEpisode: !!this.episodeId(),
    isTv: this.tv.isTv(),
    isTouch: this.device.isTouch(),
  }));

  /**
   * Visibility rules the closed `when` vocabulary can't express — an OR, or a
   * fact that isn't a permission (a sharing preference, in-flight request
   * state). `when` already gated everything it can; this only narrows
   * further, and only for the three ids that need it.
   */
  private readonly extraGuards: Record<string, () => boolean> = {
    'core.recommend': () => !this.auth.sharingDisabled(),
    'core.request_media': () => {
      const needsFile = this.mediaType() === 'movie' || !!this.episodeId();
      return !this.userHasOpenWholeRequest() && (!needsFile || !this.selectedFileId());
    },
    'core.edit_subtitles': () => this.mediaType() === 'movie' || !!this.episodeId(),
    // Already `requests.create && !media.delete && !<pending>` — pending is
    // per-title async state fetched by the parent, not a permission.
    'core.request_deletion': () => this.canRequestDeletion(),
  };

  private readonly actionHandlers: MediaActionHandlers = {
    'media.recommend': () => this.recommend.emit(),
    'media.toggle-series-watched': () => this.onToggleWatched(),
    'media.open-tracking': () => this.openTracking.emit(),
    'media.request': () => this.requestMedia.emit(),
    'media.grab-best': () => this.grabBest.emit(),
    'media.search-releases': () => this.loadReleases.emit(),
    'media.edit-profiles': () => this.openProfiles.emit(),
    'media.edit-library': () => this.openLibrary.emit(),
    'media.edit-subtitles': () => this.editSubtitles.emit(),
    'media.refresh-metadata': () => this.refreshMetadata.emit(),
    'media.identify': () => this.identify.emit(),
    'media.analyze': () => this.openAnalyze.emit(),
    'media.toggle-monitored': () => this.toggleMonitored.emit(),
    'media.delete': () => this.deleteMedia.emit(),
    'media.request-deletion': () => this.requestDeletion.emit(),
  };

  /** Core's list merged with the registry's plugin contributions, sorted by
   *  weight then id, `when`-filtered, with the action resolved to a handler.
   *  An unknown actionId or action.kind drops the row rather than rendering
   *  a broken one. */
  readonly menuItems = computed<ResolvedMediaAction[]>(() => {
    const merged = [...CORE_MEDIA_ACTIONS, ...this.pluginUi.contributionsFor('media.actions')]
      .sort((a, b) => a.weight - b.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ctx = this.mediaActionsContext();
    const items: ResolvedMediaAction[] = [];
    for (const c of merged) {
      if (!evaluateWhen(c.when, ctx)) continue;
      // Reusing a core actionId reuses core's gating too: a plugin may narrow one of
      // core's own actions, never widen it to someone core would hide it from.
      if (!this.passesCoreGateFor(c, ctx)) continue;
      if (!(this.extraGuards[c.id]?.() ?? true)) continue;
      const base = {
        id: c.id,
        labelKey: c.labelKey,
        icon: c.icon ?? 'circle',
        tone: c.tone ?? ('default' as const),
        confirmKey: c.confirmKey,
      };
      if (c.action.kind === 'route') {
        items.push({ ...base, route: c.action.path, handler: null });
      } else if (c.action.kind === 'action') {
        const handler = resolveMediaAction(c.action.actionId, this.actionHandlers);
        if (!handler) continue;
        items.push({ ...base, actionId: c.action.actionId, handler });
      }
      // else: unrecognised action kind — nothing rather than a broken row.
    }
    return items;
  });

  /** A contribution pointing at a core actionId must also clear that core item's own
   *  `when` and extra guard, whoever declared it. */
  private passesCoreGateFor(c: UiContribution, ctx: WhenContext): boolean {
    if (c.action.kind !== 'action') return true;
    const core = CORE_MEDIA_ACTIONS.find((a) => a.action.kind === 'action' && a.action.actionId === (c.action as { actionId: string }).actionId);
    if (!core || core.id === c.id) return true;
    return evaluateWhen(core.when, ctx) && (this.extraGuards[core.id]?.() ?? true);
  }

  /** A couple of rows swap their label by live state (watched, monitored) —
   *  cosmetic, so the swap lives here rather than in the static contribution. */
  displayLabelKey(item: ResolvedMediaAction): string {
    if (item.actionId === 'media.toggle-series-watched') {
      return this.watched() ? 'media_detail.mark_series_unwatched' : 'media_detail.mark_series_watched';
    }
    if (item.actionId === 'media.toggle-monitored') {
      return this.monitored() ? 'media_detail.unmonitor' : 'media_detail.monitor';
    }
    return item.labelKey;
  }

  /** Same idea as {@link displayLabelKey}, for the one row whose icon shape
   *  (not just tint) follows live state. */
  displayIcon(item: ResolvedMediaAction): string {
    if (item.actionId === 'media.toggle-monitored') {
      return this.monitored() ? 'eye-off' : 'eye';
    }
    return item.icon;
  }

  /** Mid-request spinner, per actionId — the ids not listed never show one. */
  isItemBusy(item: ResolvedMediaAction): boolean {
    if (item.actionId === 'media.grab-best') return this.grabBusy() === 'best';
    if (item.actionId === 'media.search-releases') return this.releasesLoading();
    if (item.actionId === 'media.delete') return this.deleteLoading();
    return false;
  }

  /** Disabled state, per actionId — the ids not listed are never disabled. */
  isItemDisabled(item: ResolvedMediaAction): boolean {
    if (item.actionId === 'media.grab-best') return this.grabBusy() !== null;
    if (item.actionId === 'media.toggle-monitored') return this.monitoredLoading();
    if (item.actionId === 'media.delete') return this.deleteLoading();
    return false;
  }
}
