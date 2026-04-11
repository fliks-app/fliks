import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { StreamingApiService, PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import { SubtitlesApiService } from '../../core/services/api/subtitles-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService } from '../../core/services/browser-device-profile.service';
import { SseService } from '../../core/services/sse.service';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { NetworkService } from '../../core/services/network.service';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { parseAudioIndex, SpriteMetadata } from '../../core/utils/player.utils';
import {
  PlayerSettingsService, normalizeLang,
  SUBTITLE_SIZE_MAP, SUBTITLE_COLOR_MAP, SUBTITLE_SHADOW_MAP, SUBTITLE_BG_MAP,
} from '../../core/services/player-settings.service';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface ImmersivePlugin {
  enter(options?: { displayBehindNotch?: boolean }): Promise<void>;
  exit(): Promise<void>;
  setLightStatusBar(options: { light: boolean }): Promise<void>;
}
const Immersive = registerPlugin<ImmersivePlugin>('Immersive');

interface PipPlugin {
  enter(): Promise<void>;
  setAutoEnter(options: { enabled: boolean }): Promise<void>;
  updatePlaybackState(options: { playing: boolean }): Promise<void>;
}
const Pip = registerPlugin<PipPlugin>('Pip');
import { LucideCircleAlert } from '@lucide/angular';
import { CastAudioOption } from '../../core/services/cast-player.service';
import { PlayerControlsComponent } from './controls/player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './overlay/player-stats-overlay';
import shaka from 'shaka-player';

interface SubtitleOption {
  id: string;
  label: string;
  url: string;
  language: string;
  /** True for bitmap subs (PGS/VOBSUB) that need server-side burn-in */
  burnIn: boolean;
  /** Database subtitle ID (for burn-in request) */
  subtitleDbId?: number;
  /** True if this is a forced subtitle track */
  forced?: boolean;
}

interface QualityOption {
  id: string;      // 'auto' | 'original' | '1080p' | '720p' | '480p'
  label: string;   // "Auto", "Original (4K)", "1080p", "720p", "480p"
  height: number;  // 0 for auto, source height for original, profile height
}

/** Persisted user choice for quality (same key across sessions). */
const PLAYER_QUALITY_STORAGE_KEY = 'player.qualityId';

/**
 * ABR: prefer starting at 720p+ and staying there when possible; below 720 only
 * when no variant meets the restriction (very slow network / low source res).
 */
const ABR_DEFAULT_BANDWIDTH_ESTIMATE = 4_500_000;
const ABR_MIN_HEIGHT_PREFERENCE = 720;

@Component({
  imports: [TranslateModule, LucideCircleAlert, PlayerControlsComponent, PlayerStatsOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  encapsulation: ViewEncapsulation.None,
  styles: [`
    .player-container {
      position: fixed;
      inset: 0;
      background-color: #000;
      z-index: 100;
      overflow: hidden;
    }
    .player-container.hide-cursor {
      cursor: none;
    }
    .player-video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `],
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly offlineStorage = inject(OfflineStorageService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  private readonly network = inject(NetworkService);
  private readonly dlCache = inject(DownloadCacheService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly mediaService = inject(MediaService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);
  private readonly sseService = inject(SseService);
  private readonly authService = inject(AuthService);
  readonly castService = inject(CastService);
  private readonly castPlayerService = inject(CastPlayerService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');
  private player: shaka.Player | null = null;
  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private controlsTimeout: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  private subtitleStyleEl: HTMLStyleElement | null = null;

  // State
  readonly loading = signal(true);
  readonly videoStarted = signal(false);
  readonly error = signal<string | null>(null);
  readonly paused = signal(true);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  readonly playbackRate = signal(1);
  readonly controlsVisible = signal(true);
  readonly buffering = signal(false);
  readonly bufferedEnd = signal(0);
  readonly inPipMode = signal(false);
  private readonly isLandscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);
  readonly statsVisible = signal(false);
  readonly fillScreen = signal(false);
  /** Forces stats recomputation while overlay is open (e.g. Shaka getStats, paused playback). */
  private readonly statsRefreshTick = signal(0);
  readonly subtitlePickerOpen = signal(false);
  readonly qualityPickerOpen = signal(false);
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeQualityId = signal('auto');
  readonly activeResolution = signal('');
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<{ id: string; label: string; language: string }[]>([]);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);
  readonly availableQualities = signal<QualityOption[]>([]);

  /** Audio tracks from streamInfo for the Cast remote */
  readonly castAudioOptions = computed<CastAudioOption[]>(() => {
    const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
    const si = file?.streamInfo as any;
    if (!si?.audio?.length) return [];
    return si.audio.map((a: any, i: number) => ({
      id: `audio-${i}`,
      label: `${a.language ?? 'und'}${a.title ? ' - ' + a.title : ''} (${(a.codec ?? '').toUpperCase()}${a.channels ? ' ' + a.channels + 'ch' : ''})`,
      language: a.language ?? 'und',
    }));
  });

  readonly isNative = Capacitor.isNativePlatform();

  // Sync local playback with Cast connection state
  private wasCasting = false;
  private readonly castSyncEffect = effect(() => {
    const casting = this.castService.isConnected();
    if (casting && !this.wasCasting) {
      // Just connected — mute/pause local video
      try {
        const video = this.videoEl()?.nativeElement;
        if (video && !video.paused) video.pause();
        if (video) video.muted = true;
      } catch { /* video element may not be ready yet */ }
    } else if (!casting && this.wasCasting) {
      // Just disconnected — reload Shaka and resume local playback at Cast position
      const castPos = this.castService.currentTime();
      this.resumeLocalAfterCast(castPos);
    }
    this.wasCasting = casting;
  });

  // Remote control: listen for admin commands via SSE
  private readonly remoteCommandEffect = effect(() => {
    const event = this.sseService.lastEvent();
    if (!event || event.type !== 'player.command') return;
    const cmd = event as any;
    const currentUserId = this.authService.user()?.id;
    if (cmd.mediaFileId !== this.mediaFileId || cmd.userId !== currentUserId) return;

    if (this.castService.isConnected()) {
      if (cmd.action === 'pause') this.castService.pause();
      else if (cmd.action === 'play') this.castService.play();
      else if (cmd.action === 'stop') { this.castService.disconnect(); this.onBack(); }
    } else {
      const video = this.videoEl()?.nativeElement;
      if (cmd.action === 'pause' && video && !video.paused) video.pause();
      else if (cmd.action === 'play' && video && video.paused) video.play();
      else if (cmd.action === 'stop') this.onBack();
    }
  });

  // Immersive mode: landscape=always, portrait=only while playing with controls hidden
  private readonly immersiveEffect = effect(() => {
    if (!this.isNative || this.inPipMode()) return;
    const landscape = this.isLandscape();
    const shouldBeImmersive = landscape || (!this.paused() && !this.controlsVisible());
    if (shouldBeImmersive) {
      Immersive.enter({ displayBehindNotch: true }).catch(() => {});
      document.body.classList.add('immersive');
    } else {
      Immersive.exit().catch(() => {});
      document.body.classList.remove('immersive');
      // Player bg is black → white status bar icons
      Immersive.setLightStatusBar({ light: false }).catch(() => {});
    }
  });

  // Sync play/pause state to PiP action button
  private readonly pipPlaybackEffect = effect(() => {
    if (!this.isNative) return;
    Pip.updatePlaybackState({ playing: !this.paused() }).catch(() => {});
  });

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
  private isOfflinePlayback = false;
  private episodeId: number | undefined;
  private media: Media | null = null;
  private activeBurnInId: number | null = null;

  readonly mediaTitle = signal('');
  readonly episodeTitle = signal('');
  readonly fanartUrl = signal<string | null>(null);
  readonly playbackMode = signal<'direct' | 'remux' | 'transcode'>('direct');
  readonly hwAccel = signal('none');
  private playbackInfo: PlaybackInfoResponse | null = null;

  readonly playerStats = computed<PlayerStats | null>(() => {
    if (!this.statsVisible()) return null;
    const video = this.videoEl()?.nativeElement;
    if (!video) return null;

    // Read signals so Angular tracks them as dependencies
    const _time = this.currentTime();
    const _quality = this.activeQualityId();
    void this.statsRefreshTick();

    const pi = this.playbackInfo;
    const src = pi?.source;
    const shakaStats = this.player?.getStats();
    const mode = this.playbackMode();
    const hw = this.hwAccel();

    // Get the currently playing variant track from Shaka (reflects quality switch)
    const activeTrack = this.player?.getVariantTracks()?.find(t => t.active);

    // Determine effective copy/transcode state based on selected quality
    // "auto"/"original" in direct/remux → follows initial playbackInfo
    // Any specific transcode profile (1080p/720p/480p) → video IS being transcoded
    const isTranscodeQuality = !['auto', 'original'].includes(_quality);
    const effectiveVideoCopy = isTranscodeQuality ? false : (pi?.videoCopyStream ?? true);
    const effectiveAudioCopy = isTranscodeQuality ? false : (pi?.audioCopyStream ?? true);

    /** Same formatting as media-file-info (bps). */
    const formatBitrateBps = (bps: number): string => {
      if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
      if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
      return `${bps} bps`;
    };

    // --- Container (summary) ---
    const totalContainerBps =
      src?.formatBitRate ??
      (src?.videoBitRate != null
        ? (src.videoBitRate ?? 0) + (src.audioBitRate ?? 0)
        : undefined);
    const containerBitrate =
      totalContainerBps != null && totalContainerBps > 0
        ? formatBitrateBps(totalContainerBps)
        : '?';

    const isHls = mode !== 'direct' || isTranscodeQuality;
    const outputFormat = isHls ? 'HLS' : '';
    const outputFps = src?.frameRate ?? '';

    const audioTranscodeNote = !effectiveAudioCopy && src?.audioCodec !== 'aac'
      ? 'Audio transcoded to a compatible codec'
      : '';

    // --- Video label (playing resolution from Shaka when available) ---
    const playingWidth = activeTrack?.width ?? src?.width;
    const playingHeight = activeTrack?.height ?? src?.height;
    const resLabel = this.resolutionLabel(playingWidth, playingHeight);
    const hdrTag = src?.hdrFormat ? ` ${src.hdrFormat}` : '';
    const codecName = (src?.videoCodec ?? '?').toUpperCase();
    const videoLabel = `${resLabel}${hdrTag} ${codecName}`;

    const rateMap = pi?.transcodeBitrateByQuality;
    const qId = _quality;
    const sourceA = src?.audioBitRate;

    /** Selected HLS profile entry (same resolution as stream bitrate logic). */
    let selectedRateEntry: {
      videoBitrateBps: number;
      audioBitrateBps: number;
      totalBitrateBps: number;
    } | null = null;
    if (rateMap && qId !== 'auto' && qId !== 'original' && rateMap[qId]) {
      selectedRateEntry = rateMap[qId];
    } else if (rateMap && (qId === 'auto' || qId === 'original')) {
      const tier = this.transcodeTierFromVariantHeight(activeTrack?.height ?? 0);
      if (tier && rateMap[tier]) selectedRateEntry = rateMap[tier];
    }

    const validBps = (n: unknown): n is number =>
      typeof n === 'number' && !Number.isNaN(n) && n > 0;

    // Video stream bitrate: server manifest BANDWIDTH, else Shaka variant / total.
    let videoStreamBitrate = '';
    let serverStreamTotalBps: number | undefined;
    if (selectedRateEntry) {
      serverStreamTotalBps = selectedRateEntry.totalBitrateBps;
    } else if (
      pi?.playMethod === 'DirectStream' &&
      qId === 'original' &&
      validBps(pi.remuxMasterBandwidthBps)
    ) {
      serverStreamTotalBps = pi.remuxMasterBandwidthBps;
    } else if (pi?.playMethod === 'DirectStream' && validBps(pi.remuxMasterBandwidthBps)) {
      serverStreamTotalBps = pi.remuxMasterBandwidthBps;
    }

    if (serverStreamTotalBps != null && serverStreamTotalBps > 0) {
      videoStreamBitrate = formatBitrateBps(serverStreamTotalBps);
    } else {
      const trackVbw = activeTrack?.videoBandwidth;
      const shakaStreamBw = (shakaStats as { streamBandwidth?: number } | undefined)
        ?.streamBandwidth;
      if (validBps(trackVbw)) {
        videoStreamBitrate = formatBitrateBps(trackVbw);
      } else if (validBps(shakaStreamBw)) {
        videoStreamBitrate = formatBitrateBps(shakaStreamBw);
      }
    }

    const profileParts: string[] = [];
    if (src?.videoProfile) profileParts.push(src.videoProfile);
    if (src?.videoLevel) profileParts.push(String(src.videoLevel));
    if (src?.frameRate) profileParts.push(`${src.frameRate} fps`);
    const videoProfileLine = profileParts.join('  ') || '?';

    // Playback mode for video
    let videoPlaybackMode: string;
    if (effectiveVideoCopy) {
      videoPlaybackMode = 'Direct playback';
    } else {
      videoPlaybackMode = hw !== 'none' ? `Transcoding (${hw.toUpperCase()})` : 'Transcoding (CPU)';
    }
    // Show current resolution if transcoding to a lower quality
    if (activeTrack && playingHeight && src?.height && playingHeight < src.height) {
      videoPlaybackMode += ` → ${playingWidth}x${playingHeight}`;
    }
    if (pi?.tonemapping) {
      videoPlaybackMode += ' (HDR → SDR)';
    }

    // --- Audio ---
    const channelLabel = src?.audioChannelLayout ?? (src?.audioChannels ? `${src.audioChannels}ch` : '');
    const langLabel = src?.audioLanguage ? src.audioLanguage.charAt(0).toUpperCase() + src.audioLanguage.slice(1) : '?';
    const audioCodecUpper = (src?.audioCodec ?? '?').toUpperCase();
    const audioLabel = `${langLabel} ${audioCodecUpper} ${channelLabel}`;

    let audioStreamBitrate = '';
    if (selectedRateEntry) {
      audioStreamBitrate = formatBitrateBps(selectedRateEntry.audioBitrateBps);
    } else if (validBps(sourceA) && pi?.playMethod === 'DirectStream') {
      audioStreamBitrate = formatBitrateBps(sourceA);
    } else {
      const trackAbw = (activeTrack as { audioBandwidth?: number } | undefined)?.audioBandwidth;
      if (validBps(trackAbw)) {
        audioStreamBitrate = formatBitrateBps(trackAbw);
      }
    }

    const audioDetailLine = src?.audioSampleRate ? `${src.audioSampleRate} Hz` : '?';

    let audioPlaybackMode: string;
    if (effectiveAudioCopy) {
      audioPlaybackMode = 'Direct playback';
    } else {
      const outCodec = isTranscodeQuality ? 'AAC' : (pi?.outputAudioCodec ?? 'aac').toUpperCase();
      audioPlaybackMode = `Transcode (${outCodec} 192 kbps)`;
    }

    return {
      container: src?.container ?? '?',
      containerBitrate,
      outputFormat,
      outputFps,
      audioTranscodeNote,
      videoLabel,
      videoStreamBitrate,
      videoProfileLine,
      videoPlaybackMode,
      droppedFrames: shakaStats?.droppedFrames ?? 0,
      audioLabel,
      audioStreamBitrate,
      audioDetailLine,
      audioPlaybackMode,
    };
  });

  async ngAfterViewInit() {
    // On native: listen to orientation changes (immersive handled by effect)
    if (this.isNative) {
      screen.orientation?.addEventListener('change', this.onOrientationChange);
    }

    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      this.error.set('Browser not supported');
      this.loading.set(false);
      return;
    }

    const qp = this.route.snapshot.queryParams;
    this.mediaFileId = +this.route.snapshot.params['mediaFileId'];
    this.mediaId = qp['mediaId'] ? +qp['mediaId'] : 0;
    this.episodeId = qp['episodeId'] ? +qp['episodeId'] : undefined;
    const resumeTime = 't' in qp ? +qp['t'] : undefined;

    const video = this.videoEl()!.nativeElement;
    this.player = new shaka.Player();
    await this.player.attach(video);

    this.player.configure({
      streaming: {
        bufferingGoal: 60,
        rebufferingGoal: 5,
        bufferBehind: 60,
      },
    } as any);

    // Video event listeners
    video.addEventListener('timeupdate', () => {
      this.currentTime.set(video.currentTime);
    });
    video.addEventListener('durationchange', () => {
      // Only use video.duration if we don't already have a reliable duration from ffprobe
      // and if the reported duration is finite and reasonable
      const current = this.duration();
      if (!current && isFinite(video.duration) && video.duration > 0) {
        this.duration.set(video.duration);
      }
    });
    video.addEventListener('play', () => this.paused.set(false));
    video.addEventListener('pause', () => this.paused.set(true));
    video.addEventListener('waiting', () => this.buffering.set(true));
    video.addEventListener('playing', () => { this.buffering.set(false); this.error.set(null); });
    video.addEventListener('canplay', () => this.buffering.set(false));
    video.addEventListener('volumechange', () => {
      this.volume.set(video.muted ? 0 : video.volume);
    });
    video.addEventListener('progress', () => {
      const buf = video.buffered;
      if (buf.length > 0) {
        this.bufferedEnd.set(buf.end(buf.length - 1));
      }
    });

    this.player.addEventListener('error', (e: any) => {
      this.error.set(e.detail?.message ?? 'Playback error');
    });

    try {
      // Only use offline playback if explicitly requested via query param (e.g. from downloads page)
      const offlineCheck = qp['offline'] === '1'
        ? await this.offlineStorage.getLocalUrl(`download-${this.mediaFileId}`).catch(() => null)
        : null;
      if (offlineCheck) this.isOfflinePlayback = true;

      // Load media info (skip if offline)
      if (this.mediaId && !this.isOfflinePlayback) {
        const media = await this.mediaService.getOne(this.mediaId);
        this.media = media;
        this.mediaTitle.set(media.title);
        if (media.fanartUrl) this.fanartUrl.set(this.serverConfig.resolveUrl(media.fanartUrl));

        // Build episode title (e.g. "S2:E3 - Episode Name")
        const file = media.files?.find((f: any) => f.id === this.mediaFileId);
        if (this.episodeId && media.seasons) {
          for (const season of media.seasons) {
            const ep = season.episodes?.find(e => e.id === this.episodeId);
            if (ep) {
              const label = `S${season.seasonNumber}:E${ep.episodeNumber}`;
              this.episodeTitle.set(ep.title ? `${label} - ${ep.title}` : label);
              break;
            }
          }
        }

        // Use duration from streamInfo (reliable, from ffprobe)
        const si = file?.streamInfo as any;
        const knownDuration = si?.durationSeconds;
        if (knownDuration && knownDuration > 0) {
          this.duration.set(knownDuration);
        }
      }

      // Set MediaSession metadata (Android notification, PiP, recent apps)
      if ('mediaSession' in navigator) {
        const artwork: MediaImage[] = [];
        if (this.media?.posterUrl) artwork.push({ src: this.serverConfig.resolveUrl(this.media.posterUrl), sizes: '300x450', type: 'image/jpeg' });
        if (this.media?.fanartUrl) artwork.push({ src: this.serverConfig.resolveUrl(this.media.fanartUrl), sizes: '1280x720', type: 'image/jpeg' });
        navigator.mediaSession.metadata = new MediaMetadata({
          title: this.episodeTitle() || this.mediaTitle(),
          artist: this.episodeTitle() ? this.mediaTitle() : undefined,
          artwork,
        });
      }

      video.addEventListener('error', () => {
        const e = video.error;
        console.error('[Player] Video error:', e?.code, e?.message);
        this.error.set(e?.message ?? `Video error code ${e?.code}`);
      });

      if (this.isOfflinePlayback) {
        // Offline: load via Shaka for subtitle track support (addTextTrackAsync)
        console.log('[Player] Playing offline file via Shaka');
        this.playbackMode.set('direct');

        // Determine resume position for offline playback
        let offlineStartTime: number | undefined = resumeTime ?? undefined;
        if (offlineStartTime == null) {
          try {
            const state = await this.streamingApi.getPlaybackState(this.mediaFileId);
            if (state && !state.completed && state.positionSeconds > 10) {
              offlineStartTime = state.positionSeconds;
            }
          } catch { /* offline — state may not be available */ }
        }

        await this.player.load(offlineCheck!, offlineStartTime, 'video/mp4');
      } else {
        // ── Pre-compute all preferences BEFORE starting any backend stream ──

        // 1. Determine resume position
        let startTime: number | undefined = resumeTime ?? undefined;
        console.log('[Player] resumeTime from URL:', resumeTime);
        if (startTime == null) {
          try {
            const state = await this.streamingApi.getPlaybackState(this.mediaFileId);
            console.log('[Player] PlaybackState from API:', state);
            if (state && !state.completed && state.positionSeconds > 10) {
              startTime = state.positionSeconds;
            }
          } catch (err) {
            console.warn('[Player] getPlaybackState failed:', err);
          }
        }
        console.log('[Player] Final startTime:', startTime);

        // 2. Determine preferred audio stream index from settings + streamInfo
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        const audioStreams: { language?: string }[] = (file?.streamInfo as any)?.audio ?? [];
        const preselectedAudioIndex = this.playerSettings.resolveAudioStreamIndex(
          this.mediaFileId, audioStreams,
        );
        this.activeAudioStreamIndex = preselectedAudioIndex;

        // 3. Ask the backend to decide how to play — pass audio index upfront
        const deviceProfile = this.deviceProfileService.getProfile();
        this.playbackInfo = await this.streamingApi.getPlaybackInfo(
          this.mediaFileId, deviceProfile, undefined, preselectedAudioIndex,
        );
        const pi = this.playbackInfo;

        // Map backend decision to our mode signal
        if (pi.playMethod === 'DirectPlay') {
          this.playbackMode.set('direct');
        } else if (pi.playMethod === 'DirectStream') {
          this.playbackMode.set('remux');
        } else {
          this.playbackMode.set('transcode');
        }

        this.hwAccel.set(pi.hwAccel);

        // 4. Build quality options and apply saved preference BEFORE load
        this.buildQualityOptions(pi);
        this.applySavedQualityPreferenceFromStorage();

        const mode = this.playbackMode();
        console.log('[Player] mediaFileId:', this.mediaFileId, 'mode:', pi.playMethod,
          'videoCopy:', pi.videoCopyStream, 'audioCopy:', pi.audioCopyStream,
          'reasons:', pi.transcodeReasons.map(r => r.flag).join(', '),
          'startTime:', startTime, 'audioIdx:', preselectedAudioIndex);

        // 5. Configure Shaka ABR BEFORE load so it picks the right variant immediately
        if (mode === 'direct') {
          const streamUrl = this.streamingApi.getStreamUrl(this.mediaFileId);
          await this.player.load(streamUrl, startTime, 'video/mp4');
        } else {
          // Pre-configure ABR to avoid starting at 360p then switching
          const savedQuality = this.activeQualityId();
          const qualityOption = this.availableQualities().find(q => q.id === savedQuality);
          if (savedQuality === 'auto') {
            this.configureAutoAbrForHls();
          } else if (qualityOption && qualityOption.height > 0) {
            this.player.configure({
              abr: { enabled: false },
              restrictions: { minHeight: qualityOption.height, maxHeight: qualityOption.height },
            } as any);
          }

          this.player.configure({
            streaming: {
              retryParameters: { timeout: 60_000, maxAttempts: 5, baseDelay: 1000 },
            },
            manifest: {
              retryParameters: { timeout: 30_000, maxAttempts: 5, baseDelay: 1000 },
            },
          } as any);

          const hlsUrl = this.streamingApi.getHlsUrl(this.mediaFileId);
          await this.player.load(hlsUrl);
        }

        // Resume position — wait until Shaka has buffered enough to accept a seek
        if (startTime != null && startTime > 0) {
          const doSeek = () => {
            console.log('[Player] Seeking to resume position:', startTime);
            video.currentTime = startTime!;
          };
          if (video.readyState >= 2) {
            doSeek();
          } else {
            video.addEventListener('canplay', doSeek, { once: true });
          }
        }
      }

      this.applyQualityPreferenceAfterLoad();

      if (this.isOfflinePlayback) {
        await this.loadOfflineSubtitles();
        this.loadAudioTracks();
      } else {
        await this.loadSubtitles();
        this.loadAudioTracks();
      }
      await this.autoSelectSubtitle();

      // If Cast is already connected (user connected from navbar), send to Cast
      if (this.castService.isConnected()) {
        video.pause();
        video.muted = true;
        // Unload Shaka so it stops requesting HLS segments (would conflict with Cast session)
        await this.player.unload();
        const startPos = resumeTime ?? video.currentTime;
        await this.startCastFromPlayer(startPos);
      } else {
        video.play().catch(() => {
          // Autoplay may be blocked
        });
      }

      // Save position every 10 seconds + immediately on seek
      this.saveInterval = setInterval(() => this.savePosition(), 10_000);
      video.addEventListener('seeked', () => this.savePosition());

      // Apply subtitle appearance + load thumbnail sprite metadata (non-blocking)
      this.applySubtitleStyle();
      this.loadSpriteMetadata();
      video.addEventListener('playing', () => this.videoStarted.set(true), { once: true });

      // Update stats every second
      this.statsInterval = setInterval(() => {
        // Update active resolution from Shaka's current variant track
        const track = this.player?.getVariantTracks()?.find(t => t.active);
        if (track?.height) {
          this.activeResolution.set(this.resolutionLabel(track.width ?? undefined, track.height));
        }
        if (this.statsVisible()) {
          this.currentTime.set(video.currentTime);
          this.statsRefreshTick.update((n) => n + 1);
        }
      }, 1000);
    } catch (e) {
      console.error('[Player] Init error:', e);
      this.error.set((e as Error).message);
    } finally {
      this.loading.set(false);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', this.onKeyDown);

    // Best-effort cleanup on page unload (desktop). On mobile, the server-side
    // 60s timeout and dead-process detection handle cleanup.
    window.addEventListener('beforeunload', this.onBeforeUnload);

    // PiP mode change listener (native Android)
    if (this.isNative) {
      window.addEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.addEventListener('pipAction', this.onPipAction as EventListener);
      // Auto-enter PiP when user swipes home
      Pip.setAutoEnter({ enabled: true }).catch(() => {});
    }
  }

  ngOnDestroy() {
    this.savePosition();
    // Don't stop streaming sessions if handing off to Cast
    if (!this.castService.isConnected()) {
      this.stopStreamingSessions();
    }
    this.player?.destroy();
    this.removeSubtitleStyle();
    if (this.saveInterval) clearInterval(this.saveInterval);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.statsInterval) clearInterval(this.statsInterval);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    // Restore system UI when leaving player
    if (this.isNative) {
      screen.orientation?.removeEventListener('change', this.onOrientationChange);
      Immersive.exit().catch(() => {});
      document.body.classList.remove('immersive');
      Pip.setAutoEnter({ enabled: false }).catch(() => {});
      window.removeEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.removeEventListener('pipAction', this.onPipAction as EventListener);
    }
  }

  // Controls visibility
  toggleControls() {
    if (this.controlsVisible() && !this.isDropdownOpen()) {
      this.hideControls();
    } else {
      this.showControls();
    }
  }

  showControls() {
    this.controlsVisible.set(true);
    this.resetHideTimer();
  }

  private hideControls() {
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    this.controlsVisible.set(false);
  }

  private resetHideTimer() {
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    this.controlsTimeout = setTimeout(() => {
      if (!this.paused() && !this.isDropdownOpen()) this.controlsVisible.set(false);
    }, 3000);
  }

  private isDropdownOpen(): boolean {
    const active = document.activeElement;
    return !!active && !!active.closest('.dropdown');
  }

  // Player actions (local playback)
  onTogglePlay() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    if (video.paused) video.play();
    else video.pause();
  }

  onSeek(time: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, this.duration() || 0));
  }

  onVolumeChange(vol: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.volume = vol;
    video.muted = vol === 0;
  }

  onToggleMute() {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.muted = !video.muted;
  }

  onToggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      const el = this.containerEl()?.nativeElement ?? document.documentElement;
      el.requestFullscreen();
    }
  }

  onTogglePip() {
    if (this.isNative) {
      Pip.enter().catch(() => {});
      return;
    }
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else {
      video.requestPictureInPicture();
    }
  }

  async onToggleCast() {
    if (this.castService.isConnected()) {
      this.castService.disconnect();
      return;
    }

    // Pause video immediately while connecting
    const video = this.videoEl()?.nativeElement;
    const wasPlaying = video && !video.paused;
    const currentPos = video?.currentTime ?? 0;
    if (video) video.pause();

    this.castService.requestSession();

    // Wait for connection (poll for up to 30s)
    for (let i = 0; i < 60; i++) {
      if (this.castService.isConnected()) break;
      if (!this.castService.connecting()) break; // user cancelled
      await new Promise(r => setTimeout(r, 500));
    }

    if (!this.castService.isConnected()) {
      // Connection failed or cancelled — restore playback
      if (wasPlaying && video) video.play().catch(() => {});
      return;
    }

    // Connected — hand off to Cast and leave the player page
    if (video) video.muted = true;
    if (this.player) await this.player.unload();
    await this.startCastFromPlayer(currentPos);
    this.castPlayerService.expanded.set(true);
    this.onBack();
  }

  onDisconnectCast() {
    this.castService.disconnect();
    this.castPlayerService.clear();
  }

  /** Push current player state to the CastPlayerService and start streaming. */
  private async startCastFromPlayer(position?: number) {
    this.castPlayerService.startCast({
      mediaFileId: this.mediaFileId,
      mediaId: this.mediaId,
      episodeId: this.episodeId,
      mediaTitle: this.mediaTitle(),
      episodeTitle: this.episodeTitle(),
      fanartUrl: this.fanartUrl(),
      playbackMode: this.playbackMode(),
      subtitles: this.availableSubtitles().map(s => ({
        id: s.id,
        label: s.label,
        language: s.language,
        burnIn: s.burnIn,
        subtitleDbId: s.subtitleDbId,
        url: s.url,
      })),
      qualities: this.availableQualities().map(q => ({
        id: q.id,
        label: q.id === 'auto' ? 'Auto' : q.label,
      })),
      audioTracks: this.castAudioOptions(),
      activeQualityId: this.activeQualityId(),
      activeSubtitleId: this.activeSubtitleId(),
      activeAudioTrackId: this.activeAudioTrackId(),
      activeBurnInId: this.activeBurnInId,
      activeAudioStreamIndex: this.activeAudioStreamIndex,
    });
    await this.castPlayerService.reloadCastStream(position);
  }

  /** Reload Shaka and resume local playback after Cast disconnect. */
  private async resumeLocalAfterCast(castPos: number) {
    try {
      const video = this.videoEl()?.nativeElement;
      if (video) video.muted = false;
      if (this.player && this.mediaFileId) {
        const mode = this.playbackMode();
        const url = mode === 'direct'
          ? this.streamingApi.getStreamUrl(this.mediaFileId)
          : this.streamingApi.getHlsUrl(this.mediaFileId);
        const mimeType = mode === 'direct' ? 'video/mp4' : undefined;
        await this.player.load(url, castPos > 0 ? castPos : undefined, mimeType);
        this.applyQualityPreferenceAfterLoad();
        video?.play().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  onSpeedChange(rate: number) {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    video.playbackRate = rate;
    this.playbackRate.set(rate);
  }

  onBack() {
    this.savePosition();
    window.history.back();
  }

  onOpenMedia() {
    this.savePosition();
    const kind = this.media?.type === 'series' ? 'series' : 'movies';
    if (this.episodeId && kind === 'series') {
      this.router.navigate(['/series', this.mediaId, 'episode', this.episodeId]);
    } else {
      this.router.navigate(['/' + kind, this.mediaId]);
    }
  }

  // Subtitles
  async loadSubtitles() {
    if (!this.mediaId) return;
    try {
      const options: SubtitleOption[] = [];

      const subs = await this.subtitlesApi.getForMedia(this.mediaId);
      const bitmapCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
      const seen = new Set<string>();

      for (const sub of subs) {
        if (sub.mediaFileId !== this.mediaFileId) continue;
        const isBitmap = bitmapCodecs.has(sub.codec ?? '');

        if (sub.relativePath) {
          const key = `ext-${sub.language}-${sub.forced}-${sub.hearingImpaired}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: `ext-${sub.id}`,
            label: `${sub.language}${sub.hearingImpaired ? ' (HI)' : ''}${sub.forced ? ' (Forced)' : ''}`,
            url: this.streamingApi.getSubtitleUrl(this.mediaFileId, sub.id),
            language: sub.language,
            burnIn: false,
            subtitleDbId: sub.id,
            forced: sub.forced ?? false,
          });
        } else if (sub.streamIndex != null) {
          const key = `emb-${sub.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          options.push({
            id: key,
            label: `${sub.language}${sub.hearingImpaired ? ' (HI)' : ''}${sub.forced ? ' (Forced)' : ''}${isBitmap ? ' [PGS]' : ' [embedded]'}`,
            url: isBitmap ? '' : this.streamingApi.getEmbeddedSubtitleUrl(this.mediaFileId, sub.streamIndex!),
            language: sub.language,
            burnIn: isBitmap,
            subtitleDbId: sub.id,
            forced: sub.forced ?? false,
          });
        }
      }

      // Also check streamInfo for embedded subs not yet in DB
      const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
      const si = file?.streamInfo as any;
      if (si?.subtitles?.length) {
        for (const emb of si.subtitles) {
          const key = `emb-${emb.streamIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const isBitmap = bitmapCodecs.has(emb.codec);
          if (isBitmap) continue; // Bitmap from streamInfo only (no DB ID for burn-in)
          options.push({
            id: key,
            label: `${emb.language}${emb.hearingImpaired ? ' (HI)' : ''}${emb.forced ? ' (Forced)' : ''} [embedded]`,
            url: this.streamingApi.getEmbeddedSubtitleUrl(this.mediaFileId, emb.streamIndex),
            language: emb.language,
            burnIn: false,
            forced: emb.forced ?? false,
          });
        }
      }

      this.availableSubtitles.set(options);
    } catch {
      // Ignore subtitle loading errors
    }
  }

  /** Load VTT subtitle files from offline storage — same method as online (addTextTrackAsync). */
  private async loadOfflineSubtitles() {
    if (!this.player) return;

    const cached = this.dlCache.load();
    const task = cached.find((t) => t.mediaFileId === this.mediaFileId);
    if (!task?.subtitles?.length) return;

    const options: SubtitleOption[] = [];
    for (let i = 0; i < task.subtitles.length; i++) {
      const sub = task.subtitles[i];
      const key = `download-${task.mediaFileId}-sub-${sub.filename}`;
      const vttUrl = await this.offlineStorage.getSmallFileUrl(key);
      if (!vttUrl) continue;

      options.push({
        id: `offline-${i}`,
        label: `${sub.language}${sub.forced ? ' (Forced)' : ''}`,
        url: vttUrl,
        language: sub.language,
        burnIn: false,
        forced: sub.forced,
      });
    }
    this.availableSubtitles.set(options);
  }

  /** Load audio tracks from Shaka variant tracks (works in both direct play and HLS) */
  private loadAudioTracks() {
    if (!this.player) return;

    // Wait a moment for Shaka to parse the manifest/file
    setTimeout(() => {
      if (!this.player) return;
      const variants = this.player.getVariantTracks();

      // Deduplicate by audioId (each audio track appears in multiple variants for different video qualities)
      const seen = new Map<number, any>();
      for (const v of variants) {
        if (v.audioId != null && !seen.has(v.audioId)) {
          seen.set(v.audioId, v);
        }
      }

      if (seen.size <= 1) {
        // Fallback: use streamInfo if Shaka only sees one audio track
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        const si = file?.streamInfo as any;
        if (si?.audio?.length > 1) {
          const tracks = si.audio.map((a: any, i: number) => ({
            id: `si-${i}`,
            label: `${a.language ?? 'und'}${a.title ? ' - ' + a.title : ''} (${(a.codec ?? '').toUpperCase()}${a.channels ? ' ' + a.channels + 'ch' : ''})`,
            language: normalizeLang(a.language),
          }));
          this.availableAudioTracks.set(tracks);
          this.activeAudioTrackId.set(tracks[0].id);
          this.autoSelectAudioTrack(tracks);
        }
        return;
      }

      const tracks = Array.from(seen.entries()).map(([audioId, v]) => ({
        id: `shaka-${audioId}`,
        label: `${v.language ?? 'und'} (${v.audioCodec ?? '?'}${v.channelsCount ? ' ' + v.channelsCount + 'ch' : ''})`,
        language: normalizeLang(v.language),
      }));

      this.availableAudioTracks.set(tracks);
      // Set active to the currently playing one
      const active = variants.find((v: any) => v.active);
      if (active?.audioId != null) {
        this.activeAudioTrackId.set(`shaka-${active.audioId}`);
      }
      this.autoSelectAudioTrack(tracks);
    }, 2000);
  }

  /** Auto-select audio track based on user preferences. */
  private autoSelectAudioTrack(tracks: { id: string; language: string }[]) {
    const settings = this.playerSettings.get();
    if (settings.useDefaultAudioStream) return;
    // Skip if audio was already pre-selected during init (avoids reloading the stream)
    if (this.activeAudioStreamIndex != null) return;

    // Priority 1: remembered selection for this file
    if (settings.rememberAudioSelections) {
      const saved = this.playerSettings.getRememberedAudioTrack(this.mediaFileId);
      if (saved && tracks.some((t) => t.id === saved)) {
        this.onSelectAudioTrack(saved);
        return;
      }
    }

    // Priority 2: preferred language
    if (settings.preferredAudioLanguage) {
      const match = tracks.find(
        (t) => t.language === settings.preferredAudioLanguage,
      );
      if (match && match.id !== this.activeAudioTrackId()) {
        this.onSelectAudioTrack(match.id);
      }
    }
  }

  private activeAudioStreamIndex: number | undefined;

  async onSelectAudioTrack(trackId: string) {
    this.activeAudioTrackId.set(trackId);
    this.activeAudioStreamIndex = parseAudioIndex(trackId);

    // Remember selection if enabled
    if (this.playerSettings.get().rememberAudioSelections) {
      this.playerSettings.saveRememberedAudioTrack(this.mediaFileId, trackId);
    }

    // Shaka native switch (no reload) for EXT-X-MEDIA audio renditions
    if (trackId.startsWith('shaka-') && this.player) {
      const audioId = parseInt(trackId.replace('shaka-', ''), 10);
      const variants = this.player.getVariantTracks();
      const target = variants.find((v: any) => v.audioId === audioId);
      if (target) {
        this.player.selectVariantTrack(target, /* clearBuffer= */ true);
        return;
      }
    }

    // Fallback: legacy reload (direct play, single-audio files)
    await this.reloadStream();
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    if (!this.player) return;

    if (!sub) {
      try { (this.player as any).setTextVisibility(false); } catch {};
      this.activeSubtitleId.set(null);
      this.subtitlePickerOpen.set(false);
      localStorage.setItem('player.subtitleLang', '');
      localStorage.removeItem('player.subtitleForced');
      if (!this.isOfflinePlayback && this.activeBurnInId) {
        this.activeBurnInId = null;
        await this.reloadStream();
      }
      return;
    }

    if (sub.burnIn && sub.subtitleDbId) {
      // Server-side burn-in: reload stream with subtitle baked in
      this.activeBurnInId = sub.subtitleDbId;
      this.activeSubtitleId.set(sub.id);
      this.subtitlePickerOpen.set(false);
      localStorage.setItem('player.subtitleLang', sub.language);
      localStorage.setItem('player.subtitleForced', sub.forced ? '1' : '0');
      await this.reloadStream();
      return;
    }

    try {
      if (this.activeBurnInId) {
        this.activeBurnInId = null;
        if (!this.isOfflinePlayback) await this.reloadStream();
      }
      const track = await this.player.addTextTrackAsync(
        sub.url,
        sub.language,
        'subtitles',
        'text/vtt',
        undefined,
        sub.label,
      );
      this.player.selectTextTrack(track);
      try { (this.player as any).setTextVisibility(true); } catch {};
    } catch (e) {
      console.error('[Player] Failed to load subtitle:', e);
    }

    this.activeSubtitleId.set(sub.id);
    this.subtitlePickerOpen.set(false);
    localStorage.setItem('player.subtitleLang', sub.language);

    // Remember selection if enabled
    if (this.playerSettings.get().rememberSubtitleSelections) {
      this.playerSettings.saveRememberedSubtitleTrack(this.mediaFileId, sub.id);
    }
  }

  /** Auto-select subtitle based on user preferences (mode: off/intelligent/always).
   *  Burn-in subtitles are excluded to avoid triggering a stream reload during init. */
  private async autoSelectSubtitle() {
    const settings = this.playerSettings.get();
    // Exclude burn-in subs (PGS, DVD, etc.) — selecting them calls reloadStream() to bake
    // the subtitle into the video server-side, which kills the active transcode session.
    // During init the transcode just started (possibly with a seek), so reloading would
    // spawn a 3rd ffmpeg process and cause Shaka error 1003. Users can still pick burn-in
    // subs manually from the subtitle menu.
    const subs = this.availableSubtitles().filter((s) => !s.burnIn);
    if (!subs.length && !this.availableSubtitles().length) return;

    // Priority 1: remembered selection (only non-burn-in)
    if (settings.rememberSubtitleSelections) {
      const savedId = this.playerSettings.getRememberedSubtitleTrack(this.mediaFileId);
      if (savedId) {
        const match = subs.find((s) => s.id === savedId);
        if (match) { await this.selectSubtitle(match); return; }
      }
    }

    if (settings.subtitleMode === 'off') return;

    const prefLang = settings.preferredSubtitleLanguage;
    if (!prefLang) {
      // Fallback: try old localStorage key for migration
      const oldLang = localStorage.getItem('player.subtitleLang');
      if (oldLang) {
        const match = subs.find((s) => s.language === oldLang);
        if (match) await this.selectSubtitle(match);
      }
      return;
    }

    const findMatch = () =>
      subs.find((s) => s.language === prefLang && !s.forced)
      ?? subs.find((s) => s.language === prefLang);

    if (settings.subtitleMode === 'always') {
      const match = findMatch();
      if (match) await this.selectSubtitle(match);
      return;
    }

    // Intelligent mode: show subtitles only when audio language differs from preferred
    if (settings.subtitleMode === 'intelligent') {
      const audioTracks = this.availableAudioTracks();
      const activeAudioId = this.activeAudioTrackId();
      const activeAudio = audioTracks.find((t) => t.id === activeAudioId);
      const audioLang = activeAudio?.language ?? 'und';

      if (audioLang !== prefLang && audioLang !== 'und') {
        const match = findMatch();
        if (match) await this.selectSubtitle(match);
      }
    }
  }

  // Keyboard handler
  private onKeyDown = (e: KeyboardEvent) => {
    // Ignore if typing in an input
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    const video = this.videoEl()?.nativeElement;
    if (!video) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        this.onTogglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.onSeek(video.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.onSeek(video.currentTime + 10);
        break;
      case 'j':
        e.preventDefault();
        this.onSeek(video.currentTime - 30);
        break;
      case 'l':
        e.preventDefault();
        this.onSeek(video.currentTime + 30);
        break;
      case 'f':
        e.preventDefault();
        this.onToggleFullscreen();
        break;
      case 'm':
        e.preventDefault();
        this.onToggleMute();
        break;
      case 'p':
        e.preventDefault();
        this.onTogglePip();
        break;
      case 's':
        e.preventDefault();
        if (e.shiftKey) {
          this.statsVisible.set(!this.statsVisible());
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.onBack();
        break;
      case '<':
        e.preventDefault();
        this.onSpeedChange(Math.max(0.25, this.playbackRate() - 0.25));
        break;
      case '>':
        e.preventDefault();
        this.onSpeedChange(Math.min(2, this.playbackRate() + 0.25));
        break;
    }
    this.showControls();
  };

  /** Best-effort cleanup on page unload / app background. Not guaranteed on mobile — the
   *  server-side 60s timeout and dead-process detection are the real safety nets. */
  private onBeforeUnload = () => {
    this.fireAndForgetStopSessions();
  };

  private fireAndForgetStopSessions() {
    if (!this.mediaFileId || this.playbackMode() === 'direct') return;
    const url = this.streamingApi.getStopSessionsUrl(this.mediaFileId);
    fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  private stopStreamingSessions() {
    if (!this.mediaFileId || this.playbackMode() === 'direct') return;
    this.streamingApi.stopSessions(this.mediaFileId).catch(() => {});
  }

  private async savePosition() {
    if (!this.mediaId) return;

    let pos: number;
    let dur: number;

    if (this.castService.isConnected()) {
      // Playback is on Chromecast — read position from Cast receiver
      pos = this.castService.currentTime();
      dur = this.castService.duration() || this.duration();
    } else {
      const video = this.videoEl()?.nativeElement;
      if (!video || !video.currentTime) return;
      pos = video.currentTime;
      dur = isFinite(video.duration) ? video.duration : this.duration();
    }

    const payload = {
      positionSeconds: pos,
      durationSeconds: dur || 0,
      mediaId: this.mediaId,
      episodeId: this.episodeId,
    };

    if (this.network.isOnline()) {
      try {
        await this.streamingApi.updatePlaybackState(this.mediaFileId, payload);
      } catch {
        // API failed — queue for later
        this.offlineSync.queue({ mediaFileId: this.mediaFileId, ...payload });
      }
    } else {
      this.offlineSync.queue({ mediaFileId: this.mediaFileId, ...payload });
    }
  }

  private onPipModeChanged = (e: Event) => {
    const isInPip = (e as CustomEvent).detail?.isInPipMode ?? false;
    this.inPipMode.set(isInPip);
  };

  private onPipAction = (e: Event) => {
    const action = (e as CustomEvent).detail?.action;
    if (action === 'togglePlayback') {
      const video = this.videoEl()?.nativeElement;
      if (video) {
        if (video.paused) video.play();
        else video.pause();
      }
    }
  };

  private onOrientationChange = () => {
    this.isLandscape.set(screen.orientation?.type?.startsWith('landscape') ?? false);
  };

  onCloseStats() {
    this.statsVisible.set(false);
  }

  /** Reload the stream (e.g. when toggling burn-in subtitles) */
  private async reloadStream() {
    const video = this.videoEl()?.nativeElement;
    if (!video || !this.player) return;
    const currentPos = video.currentTime;

    // Stop existing sessions
    this.stopStreamingSessions();

    // Re-fetch playback info with burn-in + audio stream selection
    const deviceProfile = this.deviceProfileService.getProfile();
    this.playbackInfo = await this.streamingApi.getPlaybackInfo(
      this.mediaFileId, deviceProfile, this.activeBurnInId ?? undefined, this.activeAudioStreamIndex,
    );
    const pi = this.playbackInfo;

    if (pi.playMethod === 'DirectPlay') {
      this.playbackMode.set('direct');
    } else if (pi.playMethod === 'DirectStream') {
      this.playbackMode.set('remux');
    } else {
      this.playbackMode.set('transcode');
    }
    this.hwAccel.set(pi.hwAccel);
    this.buildQualityOptions(pi);

    const mode = this.playbackMode();
    if (mode === 'direct') {
      await this.player.load(this.streamingApi.getStreamUrl(this.mediaFileId), currentPos, 'video/mp4');
    } else {
      await this.player.load(this.streamingApi.getHlsUrl(this.mediaFileId), currentPos);
    }

    this.applyQualityPreferenceAfterLoad();

    video.play().catch(() => {});
  }

  onToggleQualityPicker() {
    this.qualityPickerOpen.set(!this.qualityPickerOpen());
    this.subtitlePickerOpen.set(false);
  }

  async selectQuality(option: QualityOption, force = false) {
    this.qualityPickerOpen.set(false);
    if (!force && option.id === this.activeQualityId()) return;
    this.activeQualityId.set(option.id);
    this.persistQualityPreference(option.id);

    if (!this.player) return;

    if (option.id === 'auto') {
      if (this.playbackMode() !== 'direct') {
        this.configureAutoAbrForHls();
      } else {
        this.player.configure({ abr: { enabled: true } } as any);
      }
      return;
    }

    // Disable ABR and lock to a specific variant
    this.player.configure({ abr: { enabled: false } } as any);
    const allTracks = this.player.getVariantTracks();
    if (!allTracks.length) return;

    // Preserve current audio track: filter variants to those matching the active audioId
    const activeTrack = allTracks.find((t: any) => t.active);
    const activeAudioId = activeTrack?.audioId;
    const tracks =
      activeAudioId != null
        ? allTracks.filter((t: any) => t.audioId === activeAudioId)
        : allTracks;
    // Fallback to all tracks if filtering left nothing
    const candidates = tracks.length ? tracks : allTracks;

    if (option.id === 'original') {
      // Pick the highest resolution track (original/remux quality)
      const best = candidates.reduce((a, b) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b));
      this.player.selectVariantTrack(best, true);
    } else {
      // Find the track closest to the requested height
      const target = option.height;
      const match = candidates.reduce((a, b) =>
        Math.abs((a.height ?? 0) - target) <= Math.abs((b.height ?? 0) - target) ? a : b,
      );
      this.player.selectVariantTrack(match, true);
    }
  }

  private readSavedQualityIdFromStorage(): string | null {
    try {
      return localStorage.getItem(PLAYER_QUALITY_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private persistQualityPreference(id: string) {
    try {
      localStorage.setItem(PLAYER_QUALITY_STORAGE_KEY, id);
    } catch {
      /* private mode / quota */
    }
  }

  /** After buildQualityOptions: restore last choice if still valid for this manifest. */
  private applySavedQualityPreferenceFromStorage() {
    const saved = this.readSavedQualityIdFromStorage();
    const ids = new Set(this.availableQualities().map(q => q.id));
    if (saved && ids.has(saved)) {
      this.activeQualityId.set(saved);
    } else {
      this.activeQualityId.set('auto');
    }
  }

  /**
   * Apply activeQualityId after load / reload (Shaka resets ABR).
   * Uses force=true so initial state matches persisted preference.
   */
  private applyQualityPreferenceAfterLoad() {
    const option = this.availableQualities().find(q => q.id === this.activeQualityId())
      ?? this.availableQualities().find(q => q.id === 'auto');
    if (!option) return;
    void this.selectQuality(option, true);
  }

  /** Optimistic ABR for HLS: bias toward 720p+, still allowed to drop if needed. */
  private configureAutoAbrForHls() {
    if (!this.player) return;
    this.player.configure({
      abr: {
        enabled: true,
        defaultBandwidthEstimate: ABR_DEFAULT_BANDWIDTH_ESTIMATE,
        useNetworkInformation: true,
        restrictions: {
          minWidth: 0,
          maxWidth: Infinity,
          minHeight: ABR_MIN_HEIGHT_PREFERENCE,
          maxHeight: Infinity,
          minPixels: 0,
          maxPixels: Infinity,
          minFrameRate: 0,
          maxFrameRate: Infinity,
          minBandwidth: 0,
          maxBandwidth: Infinity,
          minChannelsCount: 0,
          maxChannelsCount: Infinity,
        },
      },
    } as any);
  }

  onSelectQualityById(id: string) {
    const option = this.availableQualities().find(q => q.id === id);
    if (option) this.selectQuality(option);
  }

  onSelectSubtitleById(id: string | null) {
    if (id === null) {
      this.selectSubtitle(null);
    } else {
      const sub = this.availableSubtitles().find(s => s.id === id) ?? null;
      this.selectSubtitle(sub);
    }
  }

  private buildQualityOptions(pi: PlaybackInfoResponse) {
    const options: QualityOption[] = [];
    const srcH = pi.source.height ?? 0;
    const srcW = pi.source.width ?? 0;

    // Auto is always first
    options.push({ id: 'auto', label: 'Auto', height: 0 });

    if (pi.playMethod === 'DirectPlay') {
      // Only original quality
      const resLabel = this.resolutionLabel(srcW, srcH);
      options.push({ id: 'original', label: resLabel, height: srcH });
    } else {
      // Original (remux) if video can be copied
      if (pi.videoCopyStream) {
        const resLabel = this.resolutionLabel(srcW, srcH);
        options.push({ id: 'original', label: resLabel, height: srcH });
      }
      // Transcode profiles: use width to match (stable across cinema aspect ratios)
      const profiles = [
        { id: '2160p', label: '4K', height: 2160, minWidth: 3800 },
        { id: '1080p', label: '1080p', height: 1080, minWidth: 1900 },
        { id: '720p', label: '720p', height: 720, minWidth: 1260 },
        { id: '480p', label: '480p', height: 480, minWidth: 0 },
        { id: '360p', label: '360p', height: 360, minWidth: 0 },
        { id: '240p', label: '240p', height: 240, minWidth: 0 },
        { id: '144p', label: '144p', height: 144, minWidth: 0 },
      ];
      const originalLabel = pi.videoCopyStream ? this.resolutionLabel(srcW, srcH) : null;
      for (const p of profiles) {
        if (srcW >= p.minWidth && p.label !== originalLabel) {
          options.push(p);
        }
      }
    }

    this.availableQualities.set(options);
  }

  /**
   * Hauteur de la variante Shaka → clé PROFILES / transcodeBitrateByQuality.
   */
  private transcodeTierFromVariantHeight(h: number): string | null {
    if (h <= 0) return null;
    if (h >= 2160) return '2160p';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
    if (h >= 480) return '480p';
    if (h >= 360) return '360p';
    if (h >= 240) return '240p';
    return '144p';
  }

  private resolutionLabel(w?: number, h?: number): string {
    if (!w || !h) return '?';
    if (w >= 3840 || h >= 2160) return '4K';
    if (w >= 2560 || h >= 1440) return '1440p';
    if (w >= 1920 || h >= 1080) return '1080p';
    if (w >= 1280 || h >= 720) return '720p';
    if (w >= 854 || h >= 480) return '480p';
    return `${w}x${h}`;
  }

  private getStreamInfo() {
    const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
    return file?.streamInfo as any;
  }

  /** Inject dynamic video::cue CSS based on subtitle appearance settings. */
  private applySubtitleStyle() {
    const s = this.playerSettings.get();
    const fontSize = SUBTITLE_SIZE_MAP[s.subtitleSize] ?? '0.9em';
    const color = SUBTITLE_COLOR_MAP[s.subtitleColor] ?? '#ffffff';
    const shadow = SUBTITLE_SHADOW_MAP[s.subtitleShadow] ?? 'none';
    const bg = SUBTITLE_BG_MAP[s.subtitleBackground] ?? 'transparent';

    const css = `video::cue {
  font-size: ${fontSize} !important;
  color: ${color} !important;
  background: ${bg} !important;
  background-color: ${bg} !important;
  text-shadow: ${shadow};
  line-height: 1.4;
}`;

    if (!this.subtitleStyleEl) {
      this.subtitleStyleEl = document.createElement('style');
      document.head.appendChild(this.subtitleStyleEl);
    }
    this.subtitleStyleEl.textContent = css;
  }

  /** Remove injected subtitle style on destroy. */
  private removeSubtitleStyle() {
    if (this.subtitleStyleEl) {
      this.subtitleStyleEl.remove();
      this.subtitleStyleEl = null;
    }
  }

  private async loadSpriteMetadata(): Promise<void> {
    try {
      const url = this.streamingApi.getThumbnailMetadataUrl(this.mediaFileId);
      const res = await fetch(url);
      if (!res.ok) return;
      const meta: SpriteMetadata = await res.json();
      this.spriteMetadata.set(meta);
      this.spriteUrl.set(this.streamingApi.getThumbnailSpriteUrl(this.mediaFileId));
    } catch {
      // Sprite not available, tooltip will show time only
    }
  }

}
