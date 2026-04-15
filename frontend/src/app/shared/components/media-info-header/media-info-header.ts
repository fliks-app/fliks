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
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import {
  LucideChevronLeft,
  LucideCheck,
  LucideDownload,
  LucideEllipsisVertical,
  LucideEye,
  LucideEyeOff,
  LucideFileText,
  LucideFilm,
  LucideFolder,
  LucidePlay,
  LucideRotateCcw,
  LucideSearch,
  LucideSettings,
  LucideTrash2,
} from '@lucide/angular';
import { PlayableMediaService } from '../../../core/services/playable-media.service';
import { StreamingApiService } from '../../../core/services/api/streaming-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { TrackManagerService } from '../../../core/services/track-manager.service';
import { MobileFanartHeroComponent } from '../mobile-fanart-hero';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';

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
  language: string;
  forced?: boolean;
}

interface AudioTrack {
  index: number;
  label: string;
  language: string;
}

@Component({
  selector: 'app-media-info-header',
  imports: [
    MobileFanartHeroComponent,
    ResolveUrlPipe,
    DecimalPipe, FormsModule, RouterLink, TranslateModule,
    LucideChevronLeft, LucideCheck, LucideDownload, LucideEllipsisVertical,
    LucideEye, LucideEyeOff, LucideFileText, LucideFilm, LucideFolder,
    LucidePlay, LucideRotateCcw, LucideSearch, LucideSettings, LucideTrash2,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-info-header.html',
})
export class MediaInfoHeaderComponent {
  private readonly confirmation = inject(ConfirmationService);
  private readonly translate = inject(TranslateService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly playable = inject(PlayableMediaService);
  private readonly streamingApi = inject(StreamingApiService);

  // ── Inputs: content ──
  readonly title = input.required<string>();
  readonly mediaId = input.required<number>();
  readonly episodeId = input<number | undefined>(undefined);
  readonly episodeLabel = input<string | null>(null);
  readonly rating = input<number | null>(null);
  readonly dateLabel = input<string | null>(null);
  readonly runtime = input<number | null>(null);
  readonly overview = input<string | null>(null);
  readonly directors = input<string[]>([]);
  readonly genres = input<string[]>([]);
  /** For series: label of the episode to resume (e.g. "S01:E03 - Title") */
  readonly resumeEpisodeLabel = input<string | null>(null);
  /** For series: resume context (episodeId + mediaFileId) so play() knows what to launch */
  readonly resumeEpisodeId = input<number | undefined>(undefined);
  readonly resumeMediaFileId = input<number | undefined>(undefined);
  readonly status = input<string | null>(null);
  readonly monitored = input(true);
  readonly path = input<string | null>(null);
  readonly libraryName = input<string | null>(null);
  readonly qualityProfileName = input<string | null>(null);
  readonly languageProfileName = input<string | null>(null);
  readonly tags = input<string[]>([]);

  // ── Inputs: images / navigation ──
  readonly fanartUrl = input<string | null>(null);
  readonly posterUrl = input<string | null>(null);
  readonly posterMode = input<'poster' | 'still'>('poster');
  readonly backRoute = input<string[]>(['/']);
  readonly backLabel = input<string | null>(null);

  // ── Inputs: subtitles (built by parent from SubtitleFileRow[]) ──
  readonly subtitles = input<MediaInfoHeaderSubtitle[]>([]);

  // ── Inputs: files ──
  readonly files = input<MediaInfoHeaderFile[]>([]);
  readonly selectedFileId = input<number | null>(null);
  readonly multipleFiles = computed(() => this.files().length > 1);

  // ── Inputs: permissions / loading ──
  readonly canGrab = input(false);
  readonly canEditProfiles = input(false);
  readonly isAdmin = input(false);
  readonly releasesLoading = input(false);
  readonly grabBusy = input<string | null>(null);
  readonly refreshLoading = input(false);
  readonly monitoredLoading = input(false);
  readonly deleteLoading = input(false);

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
  readonly deleteFile = output<{ fileId: number; deleteOnDisk: boolean }>();
  readonly openDownload = output<void>();
  readonly openProfiles = output<void>();
  readonly openLibrary = output<void>();
  readonly refreshMetadata = output<void>();
  readonly toggleMonitored = output<void>();
  readonly deleteMedia = output<void>();
  readonly loadReleases = output<void>();
  readonly grabBest = output<void>();
  readonly rescanFiles = output<void>();
  /** Emitted after a series-level bulk watched toggle. Parent should refresh its episode watched list. */
  readonly seriesWatchedToggled = output<{ watched: boolean }>();

  // ── Internal state ──

  readonly watched = signal(false);
  readonly resumePositionSeconds = signal<number | null>(null);
  readonly durationSeconds = signal<number | null>(null);
  readonly selectedAudioIndex = signal<number | null>(null);
  readonly selectedSubtitleId = signal<string | null>(null);

  // ── Load playback state + watched when media/episode changes ──

  private readonly loadPlaybackEffect = effect(() => {
    const mediaId = this.mediaId();
    const episodeId = this.episodeId();
    if (!mediaId) return;

    // Watched state: for a series without an episode context, derive from the
    // aggregate `seriesFullyWatched` input (see parent). Otherwise, read the
    // playback_state row as before.
    if (this.mediaType() === 'series' && !episodeId) {
      this.watched.set(this.seriesFullyWatched());
    } else {
      this.playable.loadWatchedState(mediaId, episodeId).then(v => this.watched.set(v));
    }

    // Load resume position
    this.streamingApi.getPlaybackState(mediaId, episodeId).then(ps => {
      if (ps) {
        // Pre-select last-played file
        if (ps.mediaFileId) {
          const files = this.files();
          if (files.some(f => f.id === ps.mediaFileId)) {
            this.selectedFileIdChange.emit(ps.mediaFileId);
          }
        }
        if (!ps.completed && ps.positionSeconds > 10) {
          this.resumePositionSeconds.set(ps.positionSeconds);
          this.durationSeconds.set(ps.durationSeconds);
        } else {
          this.resumePositionSeconds.set(null);
          this.durationSeconds.set(null);
        }
      }
    }).catch(() => {});
  });

  // ── Audio/subtitle defaults ──

  readonly audioTracks = computed<AudioTrack[]>(() => {
    const file = this.selectedFile();
    const audio = file?.streamInfo?.audio as any[] | undefined;
    if (!audio?.length) return [];
    return audio.map((a: any, i: number) => {
      const lang = a.language ?? 'und';
      const codec = (a.codec ?? '').toUpperCase().replace('TRUEHD', 'TrueHD');
      const ch = a.channels
        ? (a.channels === 6 ? '5.1' : a.channels === 8 ? '7.1' : a.channels + '.0')
        : '';
      return { index: i, label: `${lang} ${codec}${ch ? ' ' + ch : ''}`, language: lang };
    });
  });

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
      const [lang, type] = saved.split(':');
      const wantForced = type === 'forced';
      const subs = this.subtitles();
      const match = subs.find(s => s.language === lang && !!s.forced === wantForced)
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
      const completed = await this.playable.toggleWatched(
        mediaId,
        fileId,
        this.episodeId(),
      );
      this.watched.set(completed);
      // Backend resets positionSeconds to 0 when marking as watched — mirror
      // that locally so the resume bar disappears without a page reload.
      if (completed) {
        this.resumePositionSeconds.set(null);
        this.durationSeconds.set(null);
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
      if (sub) this.trackManager.saveSubtitleSelection(mediaId, sub.language, sub.forced);
    }
  }

  // ── Computed display values ──

  readonly videoLabel = computed(() => {
    const file = this.selectedFile();
    if (!file?.streamInfo?.video?.[0]) return null;
    const v = file.streamInfo.video[0];
    const parts: string[] = [];
    if (v.height) {
      if (v.height >= 2160) parts.push('4K');
      else if (v.height >= 1440) parts.push('1440p');
      else if (v.height >= 1080) parts.push('1080p');
      else if (v.height >= 720) parts.push('720p');
      else parts.push(`${v.height}p`);
    }
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

  /**
   * Whether to render the watched-toggle button. Visible as soon as there is a
   * file to mark, or for the series root (bulk toggle across all episodes).
   */
  readonly canToggleWatched = computed(() => {
    if (this.selectedFileId() != null) return true;
    return this.mediaType() === 'series' && !this.episodeId();
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

  async onDeleteFileClick() {
    const fileId = this.selectedFileId();
    if (!fileId) return;
    const confirmed = await this.confirmation.confirm({
      title: this.translate.instant('common.confirm'),
      message: this.translate.instant('media_detail.confirm_delete_file_disk'),
      variant: 'danger',
    });
    if (!confirmed) return;
    this.deleteFile.emit({ fileId, deleteOnDisk: true });
  }
}
