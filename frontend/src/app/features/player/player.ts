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
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService } from '../../core/services/browser-device-profile.service';
import { SseService } from '../../core/services/sse.service';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { NetworkService } from '../../core/services/network.service';
import { DownloadCacheService } from '../../core/services/download-cache.service';
import { CastPlayerService, CastAudioOption } from '../../core/services/cast-player.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { parseAudioIndex, SpriteMetadata } from '../../core/utils/player.utils';
import {
  PlayerSettingsService, normalizeLang,
  SUBTITLE_SIZE_MAP, SUBTITLE_COLOR_MAP, SUBTITLE_SHADOW_MAP, SUBTITLE_BG_MAP,
} from '../../core/services/player-settings.service';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { ShakaEngine } from '../../core/services/playback-engine/shaka-engine';
import { NativePlayer } from '../../core/plugins/native-player.plugin';
import { NativeEngine } from '../../core/services/playback-engine/native-engine';
import { CastEngine } from '../../core/services/playback-engine/cast-engine';
import { PlayerStateService } from '../../core/services/player-state.service';
import { TrackManagerService, SubtitleOption } from '../../core/services/track-manager.service';
import { QualityManagerService } from '../../core/services/quality-manager.service';

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
import { PlayerControlsComponent } from './controls/player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './overlay/player-stats-overlay';

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
    /* When using native player, make WebView layers transparent so ExoPlayer/AVPlayer shows through */
    .player-container.native-player {
      background-color: transparent !important;
    }
    .player-container.native-player > .player-video {
      display: none !important;
    }
    .player-container.hide-cursor {
      cursor: none;
    }
    .player-video {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    /* Dim controls when HDR max brightness is active.
       Uses opacity on the direct child — safe for layout since controls are already
       absolutely positioned and won't affect the video surface behind. */
    .player-container.hdr-bright app-player-controls,
    .player-container.hdr-bright > .loading-overlay {
      opacity: 0.5;
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
  private readonly mediaService = inject(MediaService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);
  private readonly sseService = inject(SseService);
  private readonly authService = inject(AuthService);
  readonly castService = inject(CastService);
  private readonly castPlayerService = inject(CastPlayerService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);

  // New extracted services
  private readonly state = inject(PlayerStateService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly qualityManager = inject(QualityManagerService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');

  /** Current playback engine (ShakaEngine | NativeEngine | CastEngine). */
  private engine: PlaybackEngine | null = null;
  readonly isNativeEngine = signal(false);

  /** Template binding — true when using native (ExoPlayer/AVPlayer) engine. */
  get nativeEngine(): boolean {
    return this.isNativeEngine();
  }

  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private controlsTimeout: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private subtitleStyleEl: HTMLStyleElement | null = null;

  // ── Template-facing signal aliases (delegate to services) ──
  readonly loading = this.state.loading;
  readonly videoStarted = this.state.videoStarted;
  readonly error = this.state.error;
  readonly paused = this.state.paused;
  readonly currentTime = this.state.currentTime;
  readonly duration = this.state.duration;
  readonly volume = this.state.volume;
  readonly buffering = this.state.buffering;
  readonly bufferedEnd = this.state.bufferedEnd;
  readonly playbackMode = this.state.playbackMode;
  readonly hwAccel = this.state.hwAccel;
  readonly activeQualityId = this.qualityManager.activeQualityId;
  readonly availableQualities = this.qualityManager.availableQualities;
  readonly activeResolution = this.qualityManager.activeResolution;

  // Component-owned signals (not delegated)
  readonly playbackRate = signal(1);
  readonly controlsVisible = signal(true);
  readonly inPipMode = signal(false);
  private readonly isLandscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);
  readonly statsVisible = signal(false);
  readonly fillScreen = signal(false);
  private readonly statsRefreshTick = signal(0);
  readonly subtitlePickerOpen = signal(false);
  readonly qualityPickerOpen = signal(false);
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<{ id: string; label: string; language: string }[]>([]);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);

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
      // Just connected — mute/pause local engine
      try {
        if (this.engine && !this.isNativeEngine()) {
          this.engine.pause().catch(() => {});
          this.engine.muted = true;
        }
      } catch { /* engine may not be ready yet */ }
    } else if (!casting && this.wasCasting) {
      // Just disconnected — reload local engine and resume at Cast position
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
    } else if (this.engine) {
      if (cmd.action === 'pause') this.engine.pause().catch(() => {});
      else if (cmd.action === 'play') this.engine.play().catch(() => {});
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
      Immersive.setLightStatusBar({ light: false }).catch(() => {});
    }
  });

  // Sync play/pause state to PiP action button
  private readonly pipPlaybackEffect = effect(() => {
    if (!this.isNative) return;
    Pip.updatePlaybackState({ playing: !this.paused() }).catch(() => {});
  });

  // HDR auto-brightness: max brightness when playing HDR, restore on pause/exit
  private readonly isHdrContent = signal(false);

  /** True when HDR max brightness is active — used to dim controls/subtitles. */
  readonly hdrBrightnessActive = computed(() => {
    if (!this.isNative || !this.isNativeEngine()) return false;
    const settings = this.playerSettings.get();
    if (!settings.hdrAutoBrightness || settings.forceDisableHdr) return false;
    return this.isHdrContent() && !this.paused();
  });

  private readonly hdrBrightnessEffect = effect(() => {
    const active = this.hdrBrightnessActive();
    if (!this.isNative) return;
    NativePlayer.setBrightness({ brightness: active ? 1.0 : -1 }).catch(() => {});
  });

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
  private isOfflinePlayback = false;
  private episodeId: number | undefined;
  private media: Media | null = null;
  private activeBurnInId: number | null = null;
  private activeAudioStreamIndex: number | undefined;

  readonly mediaTitle = signal('');
  readonly episodeTitle = signal('');
  readonly fanartUrl = signal<string | null>(null);
  private playbackInfo: PlaybackInfoResponse | null = null;

  readonly playerStats = computed<PlayerStats | null>(() => {
    if (!this.statsVisible()) return null;

    // Read signals so Angular tracks them as dependencies
    const _time = this.currentTime();
    const _quality = this.activeQualityId();
    void this.statsRefreshTick();

    const pi = this.playbackInfo;
    const src = pi?.source;
    const engineStats = this.engine?.getStats();
    const mode = this.playbackMode();
    const hw = this.hwAccel();
    const activeVariant = engineStats?.activeVariant;

    const playingWidth = activeVariant?.width ?? src?.width;
    const playingHeight = activeVariant?.height ?? src?.height;

    // Determine effective copy/transcode state based on selected quality
    const isTranscodeQuality = !['auto', 'original'].includes(_quality);
    const effectiveVideoCopy = isTranscodeQuality ? false : (pi?.videoCopyStream ?? true);
    const effectiveAudioCopy = isTranscodeQuality ? false : (pi?.audioCopyStream ?? true);

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

    // --- Video label ---
    const resLabel = this.qualityManager.resolutionLabel(playingWidth, playingHeight);
    const hdrTag = src?.hdrFormat ? ` ${src.hdrFormat}` : '';
    const codecName = (src?.videoCodec ?? '?').toUpperCase();
    const videoLabel = `${resLabel}${hdrTag} ${codecName}`;

    const rateMap = pi?.transcodeBitrateByQuality;
    const qId = _quality;
    const sourceA = src?.audioBitRate;

    let selectedRateEntry: {
      videoBitrateBps: number;
      audioBitrateBps: number;
      totalBitrateBps: number;
    } | null = null;
    if (rateMap && qId !== 'auto' && qId !== 'original' && rateMap[qId]) {
      selectedRateEntry = rateMap[qId];
    } else if (rateMap && (qId === 'auto' || qId === 'original')) {
      const tier = this.qualityManager.transcodeTierFromVariantHeight(activeVariant?.height ?? 0);
      if (tier && rateMap[tier]) selectedRateEntry = rateMap[tier];
    }

    const validBps = (n: unknown): n is number =>
      typeof n === 'number' && !Number.isNaN(n) && n > 0;

    // Video stream bitrate
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
      const trackVbw = activeVariant?.videoBandwidth;
      const shakaStreamBw = engineStats?.streamBandwidth;
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
    if (playingHeight && src?.height && playingHeight < src.height) {
      videoPlaybackMode += ` \u2192 ${playingWidth}x${playingHeight}`;
    }
    if (pi?.tonemapping) {
      videoPlaybackMode += ' (HDR \u2192 SDR)';
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
      const trackAbw = activeVariant?.audioBandwidth;
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
      droppedFrames: engineStats?.droppedFrames ?? 0,
      audioLabel,
      audioStreamBitrate,
      audioDetailLine,
      audioPlaybackMode,
    };
  });

  // ── Lifecycle ──

  async ngAfterViewInit() {
    this.state.reset();

    // On native: listen to orientation changes (immersive handled by effect)
    if (this.isNative) {
      screen.orientation?.addEventListener('change', this.onOrientationChange);
    }

    const qp = this.route.snapshot.queryParams;
    this.mediaFileId = +this.route.snapshot.params['mediaFileId'];
    this.mediaId = qp['mediaId'] ? +qp['mediaId'] : 0;
    this.episodeId = qp['episodeId'] ? +qp['episodeId'] : undefined;
    const resumeTime = 't' in qp ? +qp['t'] : undefined;

    try {
      // Only use offline playback if explicitly requested via query param
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
          this.state.duration.set(knownDuration);
        }
      }

      // Set MediaSession metadata
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

      // Determine resume position
      let startTime: number | undefined = resumeTime ?? undefined;
      if (startTime == null) {
        try {
          const playbackState = await this.streamingApi.getPlaybackState(this.mediaFileId);
          if (playbackState && !playbackState.completed && playbackState.positionSeconds > 10) {
            startTime = playbackState.positionSeconds;
          }
        } catch { /* playback state may not be available */ }
      }

      if (this.isOfflinePlayback) {
        this.state.playbackMode.set('direct');
        if (this.isNative) {
          // Offline on native: use ExoPlayer with the native file path
          await this.createNativeEngine();
          const nativePath = await this.offlineStorage.getNativeDestPath(`download-${this.mediaFileId}`);
          const fileUrl = nativePath ? `file://${nativePath}` : offlineCheck!;
          await this.engine!.load(fileUrl, startTime, 'video/mp4');
        } else {
          // Offline on web: use Shaka
          await this.createShakaEngine();
          await this.engine!.load(offlineCheck!, startTime, 'video/mp4');
        }
      } else {
        // Pre-compute audio preference
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        const audioStreams: { language?: string }[] = (file?.streamInfo as any)?.audio ?? [];
        const preselectedAudioIndex = this.playerSettings.resolveAudioStreamIndex(
          this.mediaFileId, audioStreams, this.mediaId,
        );
        this.activeAudioStreamIndex = preselectedAudioIndex;

        // Ask the backend to decide how to play
        const deviceProfile = this.deviceProfileService.getProfile();
        this.playbackInfo = await this.streamingApi.getPlaybackInfo(
          this.mediaFileId, deviceProfile, undefined, preselectedAudioIndex,
        );
        const pi = this.playbackInfo;
        this.isHdrContent.set(!!pi.source?.hdrFormat);

        // Map backend decision to mode signal
        if (pi.playMethod === 'DirectPlay') {
          this.state.playbackMode.set('direct');
        } else if (pi.playMethod === 'DirectStream') {
          this.state.playbackMode.set('remux');
        } else {
          this.state.playbackMode.set('transcode');
        }
        this.state.hwAccel.set(pi.hwAccel);

        // Build quality options and apply saved preference BEFORE load
        this.qualityManager.buildQualityOptions(pi);
        this.qualityManager.applySavedPreference();

        const mode = this.playbackMode();

        // ── Engine selection ──
        if (this.isNative && mode !== 'direct') {
          await this.createNativeEngine();

          // Apply subtitle style to native player
          const subSettings = this.playerSettings.get();
          (this.engine as NativeEngine).setSubtitleStyle({
            size: subSettings.subtitleSize,
            color: subSettings.subtitleColor,
            shadow: subSettings.subtitleShadow,
            background: subSettings.subtitleBackground,
            bottomMargin: subSettings.subtitleBottomMargin,
          });

          // Pre-load subtitles so they're included in ExoPlayer's MediaItem (no rebuild needed)
          const subs = await this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );
          this.availableSubtitles.set(subs);
          const nonBurnInSubs = subs
            .filter((s) => !s.burnIn && s.url)
            .map((s) => ({ url: s.url, language: s.language, label: s.label }));
          (this.engine as NativeEngine).setPreloadedSubtitles(nonBurnInSubs);

          const token = this.authService.accessToken;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
          const hlsUrl = this.streamingApi.getHlsUrl(this.mediaFileId);
          await this.engine!.load(hlsUrl, startTime, undefined, headers);
        } else {
          await this.createShakaEngine();

          if (mode === 'direct') {
            const streamUrl = this.streamingApi.getStreamUrl(this.mediaFileId);
            await this.engine!.load(streamUrl, startTime, 'video/mp4');
          } else {
            if (this.activeQualityId() === 'auto') {
              this.qualityManager.selectQuality(
                { id: 'auto', label: 'Auto', height: 0 },
                this.engine, mode, true,
              );
            }

            this.engine!.configure({
              streaming: {
                retryParameters: { timeout: 60_000, maxAttempts: 5, baseDelay: 1000 },
              },
              manifest: {
                retryParameters: { timeout: 30_000, maxAttempts: 5, baseDelay: 1000 },
              },
            });

            const hlsUrl = this.streamingApi.getHlsUrl(this.mediaFileId);
            await this.engine!.load(hlsUrl);
          }

          // Resume position (Shaka needs to buffer before accepting a seek)
          if (startTime != null && startTime > 0) {
            const video = this.videoEl()?.nativeElement;
            if (video) {
              const doSeek = () => {
                video.currentTime = startTime!;
              };
              if (video.readyState >= 2) {
                doSeek();
              } else {
                video.addEventListener('canplay', doSeek, { once: true });
              }
            }
          }
        }
      }

      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, this.playbackMode());

      // Load tracks (skip subtitle loading if already preloaded for native engine)
      if (this.isOfflinePlayback) {
        await this.loadOfflineSubtitles();
        this.loadAudioTracks();
      } else if (!this.availableSubtitles().length) {
        const subs = await this.trackManager.loadSubtitles(
          this.mediaId, this.mediaFileId, this.streamingApi, this.media,
        );
        this.availableSubtitles.set(subs);
        this.loadAudioTracks();
      } else {
        this.loadAudioTracks();
      }
      await this.trackManager.autoSelectSubtitle(
        this.availableSubtitles(),
        this.availableAudioTracks(),
        this.activeAudioTrackId(),
        this.mediaFileId,
        (sub) => this.selectSubtitle(sub),
      );

      // If Cast is already connected, send to Cast
      if (this.castService.isConnected() && !this.isNativeEngine()) {
        await this.engine!.pause();
        this.engine!.muted = true;
        await this.engine!.unload();
        const startPos = resumeTime ?? this.engine!.currentTime;
        await this.startCastFromPlayer(startPos);
      } else if (!this.isNativeEngine()) {
        this.engine!.play().catch(() => {
          // Autoplay may be blocked
        });
      }

      // Hide controls after autoplay starts
      this.resetHideTimer();

      // Save position every 10s + immediately on seek
      this.saveInterval = setInterval(() => this.savePosition(), 10_000);
      const video = this.videoEl()?.nativeElement;
      if (video) video.addEventListener('seeked', () => this.savePosition());

      // Apply subtitle appearance + load thumbnail sprite metadata
      this.applySubtitleStyle();
      this.loadSpriteMetadata();

      // Update stats every second
      this.statsInterval = setInterval(() => {
        const stats = this.engine?.getStats();
        const variant = stats?.activeVariant;
        if (variant?.height) {
          this.qualityManager.activeResolution.set(
            this.qualityManager.resolutionLabel(variant.width, variant.height),
          );
        }
        if (this.statsVisible()) {
          this.state.currentTime.set(this.engine?.currentTime ?? 0);
          this.statsRefreshTick.update((n) => n + 1);
        }
      }, 1000);
    } catch (e: any) {
      console.error('[Player] Init error:', e?.code, e?.category, e?.data, e);
      this.state.error.set(e?.message ?? String(e));
    } finally {
      this.state.loading.set(false);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', this.onKeyDown);

    // Best-effort cleanup on page unload
    window.addEventListener('beforeunload', this.onBeforeUnload);

    // PiP mode change listener (native Android)
    if (this.isNative) {
      window.addEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.addEventListener('pipAction', this.onPipAction as EventListener);
      Pip.setAutoEnter({ enabled: true }).catch(() => {});
    }
  }

  ngOnDestroy() {
    this.savePosition();
    if (!this.castService.isConnected()) {
      this.stopStreamingSessions();
    }
    if (this.engine) {
      if (this.isNativeEngine()) {
        document.documentElement.classList.remove('native-player-active');
        // Restore system brightness
        NativePlayer.setBrightness({ brightness: -1 }).catch(() => {});
      }
      this.engine.destroy().catch(() => {});
    }
    this.removeSubtitleStyle();
    if (this.saveInterval) clearInterval(this.saveInterval);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.statsInterval) clearInterval(this.statsInterval);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    if (this.isNative) {
      screen.orientation?.removeEventListener('change', this.onOrientationChange);
      Immersive.exit().catch(() => {});
      document.body.classList.remove('immersive');
      Pip.setAutoEnter({ enabled: false }).catch(() => {});
      window.removeEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.removeEventListener('pipAction', this.onPipAction as EventListener);
    }
  }

  // ── Engine factories ──

  private async createShakaEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    const engine = new ShakaEngine();
    await engine.init(video);
    this.engine = engine;
    this.isNativeEngine.set(false);
    this.state.bindEngine(engine);

    // videoStarted tracking (first frame rendered)
    video.addEventListener('playing', () => this.state.videoStarted.set(true), { once: true });
    // Volume sync for template
    video.addEventListener('volumechange', () => {
      this.state.volume.set(video.muted ? 0 : video.volume);
    });
    // durationchange fallback: only use if we don't already have a reliable duration
    video.addEventListener('durationchange', () => {
      const current = this.state.duration();
      if (!current && isFinite(video.duration) && video.duration > 0) {
        this.state.duration.set(video.duration);
      }
    });
  }

  private async createNativeEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    video.style.display = 'none';

    const engine = new NativeEngine();
    const container = this.containerEl()?.nativeElement ?? video.parentElement!;
    await engine.init(container);

    // Force transparent background so native player shows through
    document.documentElement.classList.add('native-player-active');
    let el: HTMLElement | null = container;
    while (el && el !== document.documentElement) {
      el.style.setProperty('background', 'transparent', 'important');
      el = el.parentElement;
    }

    this.engine = engine;
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    // Listen for audio tracks from native engine
    engine.on('audioTracksChanged', (e) => {
      const tracks = e.tracks.map((t) => ({
        id: t.id,
        label: t.label,
        language: normalizeLang(t.language),
      }));
      this.availableAudioTracks.set(tracks);
      if (tracks.length > 0) {
        this.activeAudioTrackId.set(tracks[0].id);
        this.trackManager.autoSelectAudioTrack(
          tracks, this.mediaId, this.mediaFileId,
          this.activeAudioTrackId(),
          (trackId) => this.onSelectAudioTrack(trackId),
        );
      }
    });
  }

  // ── Controls visibility ──

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
    // Check via signals (reliable on mobile)
    if (this.subtitlePickerOpen() || this.qualityPickerOpen()) return true;
    // Check via DOM (DaisyUI dropdowns use focus-within)
    const container = this.containerEl()?.nativeElement;
    if (container?.querySelector('.dropdown:focus-within')) return true;
    const active = document.activeElement;
    return !!active && !!active.closest('.dropdown');
  }

  // ── Player actions ──

  onTogglePlay() {
    if (!this.engine) return;
    if (this.paused()) {
      this.engine.play().catch(() => {});
      this.resetHideTimer();
    } else {
      this.engine.pause().catch(() => {});
    }
  }

  onSeek(time: number) {
    const t = Math.max(0, Math.min(time, this.duration() || 0));
    if (this.engine) {
      this.engine.seek(t).catch(() => {});
      this.state.currentTime.set(t);
    }
  }

  onVolumeChange(vol: number) {
    if (!this.engine) return;
    this.engine.volume = vol;
    this.engine.muted = vol === 0;
  }

  onToggleMute() {
    if (!this.engine) return;
    this.engine.muted = !this.engine.muted;
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

    const wasPlaying = this.engine && !this.engine.paused;
    const currentPos = this.engine?.currentTime ?? 0;
    if (this.engine) this.engine.pause().catch(() => {});

    this.castService.requestSession();

    // Wait for connection (poll for up to 30s)
    for (let i = 0; i < 60; i++) {
      if (this.castService.isConnected()) break;
      if (!this.castService.connecting()) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!this.castService.isConnected()) {
      if (wasPlaying && this.engine) this.engine.play().catch(() => {});
      return;
    }

    // Connected — hand off to Cast
    if (this.engine) this.engine.muted = true;
    if (this.engine) await this.engine.unload();
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

  /** Reload local engine and resume after Cast disconnect. */
  private async resumeLocalAfterCast(castPos: number) {
    try {
      if (this.engine) this.engine.muted = false;
      if (this.engine && this.mediaFileId) {
        const mode = this.playbackMode();
        const url = mode === 'direct'
          ? this.streamingApi.getStreamUrl(this.mediaFileId)
          : this.streamingApi.getHlsUrl(this.mediaFileId);
        const mimeType = mode === 'direct' ? 'video/mp4' : undefined;
        await this.engine.load(url, castPos > 0 ? castPos : undefined, mimeType);
        this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, mode);
        this.engine.play().catch(() => {});
      }
    } catch { /* ignore */ }
  }

  onSpeedChange(rate: number) {
    if (!this.engine) return;
    this.engine.playbackRate = rate;
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

  // ── Subtitles ──

  /** Load VTT subtitle files from offline storage. */
  private async loadOfflineSubtitles() {
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

  /** Load audio tracks (Shaka variant tracks or streamInfo fallback). */
  private loadAudioTracks() {
    if (!this.engine) return;

    // Wait a moment for the engine to parse the manifest/file
    setTimeout(() => {
      if (!this.engine) return;

      const engineTracks = this.engine.getAudioTracks();

      if (engineTracks.length <= 1) {
        // Fallback: use streamInfo if engine only sees one audio track
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
          this.trackManager.autoSelectAudioTrack(
            tracks, this.mediaId, this.mediaFileId,
            this.activeAudioTrackId(),
            (trackId) => this.onSelectAudioTrack(trackId),
          );
        }
        return;
      }

      const tracks = engineTracks.map(t => ({
        id: t.id,
        label: t.label,
        language: normalizeLang(t.language),
      }));

      this.availableAudioTracks.set(tracks);
      // Set active to the currently playing one
      const allVariants = this.engine.getVariantTracks();
      const active = allVariants.find((v: any) => v.active);
      if (active?.audioId != null) {
        this.activeAudioTrackId.set(`shaka-${active.audioId}`);
      }
      this.trackManager.autoSelectAudioTrack(
        tracks, this.mediaId, this.mediaFileId,
        this.activeAudioTrackId(),
        (trackId) => this.onSelectAudioTrack(trackId),
      );
    }, 2000);
  }

  async onSelectAudioTrack(trackId: string) {
    this.activeAudioTrackId.set(trackId);
    this.activeAudioStreamIndex = parseAudioIndex(trackId);
    this.resetHideTimer();

    // Save selection
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId, this.mediaFileId,
    );

    // Engine-level audio switch (Shaka native or NativeEngine)
    if (this.engine && (trackId.startsWith('shaka-') || trackId.startsWith('audio-'))) {
      await this.engine.selectAudioTrack(trackId);
      return;
    }

    // Fallback: legacy reload (direct play, single-audio files)
    await this.reloadStream();
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    if (!this.engine) return;
    this.resetHideTimer();

    if (!sub) {
      try { this.engine.setTextVisibility(false); } catch {}
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
      const track = await this.engine.addTextTrack(sub.url, sub.language, sub.label);
      this.engine.selectTextTrack(track);
      try { this.engine.setTextVisibility(true); } catch {}
    } catch (e) {
      console.error('[Player] Failed to load subtitle:', e);
    }

    this.activeSubtitleId.set(sub.id);
    this.subtitlePickerOpen.set(false);
    localStorage.setItem('player.subtitleLang', sub.language);

    if (this.playerSettings.get().rememberSubtitleSelections) {
      this.playerSettings.saveRememberedSubtitleTrack(this.mediaFileId, sub.id);
    }
  }

  // ── Keyboard handler ──

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (!this.engine) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        this.onTogglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.onSeek(this.engine.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.onSeek(this.engine.currentTime + 10);
        break;
      case 'j':
        e.preventDefault();
        this.onSeek(this.engine.currentTime - 30);
        break;
      case 'l':
        e.preventDefault();
        this.onSeek(this.engine.currentTime + 30);
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

  // ── Event handlers ──

  private onBeforeUnload = () => {
    this.fireAndForgetStopSessions();
  };

  private onPipModeChanged = (e: Event) => {
    const isInPip = (e as CustomEvent).detail?.isInPipMode ?? false;
    this.inPipMode.set(isInPip);
  };

  private onPipAction = (e: Event) => {
    const action = (e as CustomEvent).detail?.action;
    if (action === 'togglePlayback') {
      this.onTogglePlay();
    }
  };

  private onOrientationChange = () => {
    this.isLandscape.set(screen.orientation?.type?.startsWith('landscape') ?? false);
  };

  onCloseStats() {
    this.statsVisible.set(false);
  }

  onSelectQualityById(id: string) {
    const option = this.availableQualities().find(q => q.id === id);
    if (option) {
      this.qualityManager.selectQuality(option, this.engine, this.playbackMode());
    }
    this.resetHideTimer();
  }

  onSelectSubtitleById(id: string | null) {
    if (id === null) {
      this.selectSubtitle(null);
    } else {
      const sub = this.availableSubtitles().find(s => s.id === id) ?? null;
      this.selectSubtitle(sub);
    }
  }

  onToggleQualityPicker() {
    this.qualityPickerOpen.set(!this.qualityPickerOpen());
    this.subtitlePickerOpen.set(false);
  }

  // ── Private helpers ──

  /** Reload the stream (e.g. when toggling burn-in subtitles or switching audio). */
  private async reloadStream() {
    if (!this.engine) return;
    const currentPos = this.engine.currentTime;

    this.stopStreamingSessions();

    const deviceProfile = this.deviceProfileService.getProfile();
    this.playbackInfo = await this.streamingApi.getPlaybackInfo(
      this.mediaFileId, deviceProfile, this.activeBurnInId ?? undefined, this.activeAudioStreamIndex,
    );
    const pi = this.playbackInfo;

    if (pi.playMethod === 'DirectPlay') {
      this.state.playbackMode.set('direct');
    } else if (pi.playMethod === 'DirectStream') {
      this.state.playbackMode.set('remux');
    } else {
      this.state.playbackMode.set('transcode');
    }
    this.state.hwAccel.set(pi.hwAccel);
    this.qualityManager.buildQualityOptions(pi);

    const mode = this.playbackMode();
    if (mode === 'direct') {
      await this.engine.load(this.streamingApi.getStreamUrl(this.mediaFileId), currentPos, 'video/mp4');
    } else {
      await this.engine.load(this.streamingApi.getHlsUrl(this.mediaFileId), currentPos);
    }

    this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, mode);
    this.engine.play().catch(() => {});
  }

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
      pos = this.castService.currentTime();
      dur = this.castService.duration() || this.duration();
    } else if (this.engine) {
      pos = this.engine.currentTime;
      dur = this.engine.duration || this.duration();
    } else {
      return;
    }

    if (!pos) return;

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
        this.offlineSync.queue({ mediaFileId: this.mediaFileId, ...payload });
      }
    } else {
      this.offlineSync.queue({ mediaFileId: this.mediaFileId, ...payload });
    }
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
