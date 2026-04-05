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
import { SubtitlesApiService, SubtitleFileRow } from '../../core/services/api/subtitles-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService } from '../../core/services/browser-device-profile.service';
import { SseService } from '../../core/services/sse.service';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { Capacitor, registerPlugin } from '@capacitor/core';

interface ImmersivePlugin {
  enter(options?: { displayBehindNotch?: boolean }): Promise<void>;
  exit(): Promise<void>;
}
const Immersive = registerPlugin<ImmersivePlugin>('Immersive');

interface PipPlugin {
  enter(): Promise<void>;
  setAutoEnter(options: { enabled: boolean }): Promise<void>;
}
const Pip = registerPlugin<PipPlugin>('Pip');
import { LucideCircleAlert } from '@lucide/angular';
import { CastRemoteComponent, CastSubtitleOption, CastAudioOption, CastQualityOption } from './cast-remote';
import { PlayerControlsComponent } from './player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './player-stats-overlay';
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
}

interface QualityOption {
  id: string;      // 'auto' | 'original' | '1080p' | '720p' | '480p'
  label: string;   // "Auto", "Original (4K)", "1080p", "720p", "480p"
  height: number;  // 0 for auto, source height for original, profile height
}

@Component({
  imports: [TranslateModule, LucideCircleAlert, PlayerControlsComponent, PlayerStatsOverlayComponent, CastRemoteComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  styles: [`
    video::cue {
      font-size: 0.9em;
      background: transparent !important;
      background-color: transparent !important;
      text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7), 1px 1px 2px rgba(0,0,0,0.8);
      line-height: 1.4;
    }
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
  encapsulation: ViewEncapsulation.None,
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly mediaService = inject(MediaService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);
  private readonly sseService = inject(SseService);
  private readonly authService = inject(AuthService);
  readonly castService = inject(CastService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');
  private player: shaka.Player | null = null;
  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private controlsTimeout: ReturnType<typeof setTimeout> | null = null;
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  // State
  readonly loading = signal(true);
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
  readonly statsVisible = signal(false);
  readonly subtitlePickerOpen = signal(false);
  readonly qualityPickerOpen = signal(false);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeQualityId = signal('auto');
  readonly activeResolution = signal('');
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<{ id: string; label: string }[]>([]);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);
  readonly availableQualities = signal<QualityOption[]>([]);

  /** Subtitle options formatted for the Cast remote */
  readonly castSubtitleOptions = computed<CastSubtitleOption[]>(() => {
    let trackId = 1;
    return this.availableSubtitles().map(s => ({
      id: s.id,
      label: s.label,
      language: s.language,
      burnIn: s.burnIn,
      castTrackId: s.burnIn ? s.subtitleDbId : trackId++,
    }));
  });

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

  /** Quality options for the Cast remote */
  readonly castQualityOptions = computed<CastQualityOption[]>(() => {
    return this.availableQualities().map(q => ({
      id: q.id,
      label: q.id === 'auto' ? 'Auto' : q.id === 'original' ? `Original` : q.id,
    }));
  });

  readonly isNative = Capacitor.isNativePlatform();

  // Mute/pause local video whenever Cast is connected
  private readonly castSyncEffect = effect(() => {
    const casting = this.castService.isConnected();
    if (!casting) return;
    try {
      const video = this.videoEl()?.nativeElement;
      if (video && !video.paused) video.pause();
      if (video) video.muted = true;
    } catch { /* video element may not be ready yet */ }
  });

  // Remote control: listen for admin commands via SSE
  private readonly remoteCommandEffect = effect(() => {
    const event = this.sseService.lastEvent();
    if (!event || event.type !== 'player.command') return;
    const cmd = event as any;
    const currentUserId = this.authService.user()?.id;
    if (cmd.mediaFileId !== this.mediaFileId || cmd.userId !== currentUserId) return;

    if (cmd.action === 'pause') {
      const video = this.videoEl()?.nativeElement;
      if (video && !video.paused) video.pause();
    } else if (cmd.action === 'play') {
      const video = this.videoEl()?.nativeElement;
      if (video && video.paused) video.play();
    } else if (cmd.action === 'stop') {
      this.onBack();
    }
  });

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
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

    // --- Container / Flux ---
    const containerBitrate = src?.videoBitRate
      ? `${(((src.videoBitRate ?? 0) + (src.audioBitRate ?? 0)) / 1_000_000).toFixed(0)} mbps`
      : '?';

    const isHls = mode !== 'direct' || isTranscodeQuality;
    const outputFormat = isHls ? 'HLS' : '';
    // Use active track bandwidth if available, else estimated bandwidth
    const activeBw = activeTrack?.bandwidth ?? shakaStats?.estimatedBandwidth;
    const outputBitrate = activeBw
      ? `${(activeBw / 1_000_000).toFixed(0)} mbps`
      : '';
    const outputFps = src?.frameRate ?? '';

    const audioTranscodeNote = !effectiveAudioCopy && src?.audioCodec !== 'aac'
      ? 'Conversion audio en codec compatible'
      : '';

    // --- Video label ---
    // Show CURRENT playing resolution (from Shaka track), not just source
    const playingWidth = activeTrack?.width ?? src?.width;
    const playingHeight = activeTrack?.height ?? src?.height;
    const resLabel = this.resolutionLabel(playingWidth, playingHeight);
    const hdrTag = src?.hdrFormat ? ` ${src.hdrFormat}` : '';
    const codecName = (src?.videoCodec ?? '?').toUpperCase();
    const videoLabel = `${resLabel}${hdrTag} ${codecName}`;

    const profileParts: string[] = [];
    if (src?.videoProfile) profileParts.push(src.videoProfile);
    if (src?.videoLevel) profileParts.push(String(src.videoLevel));
    // Show active track bitrate if different from source
    if (activeTrack?.videoBandwidth) {
      profileParts.push(`${(activeTrack.videoBandwidth / 1_000_000).toFixed(0)} mbps`);
    } else if (src?.videoBitRate) {
      profileParts.push(`${(src.videoBitRate / 1_000_000).toFixed(0)} mbps`);
    }
    if (src?.frameRate) profileParts.push(`${src.frameRate} fps`);
    const videoProfileLine = profileParts.join('  ') || '?';

    // Playback mode for video
    let videoPlaybackMode: string;
    if (effectiveVideoCopy) {
      videoPlaybackMode = 'Lecture directe';
    } else {
      videoPlaybackMode = hw !== 'none' ? `Transcodage (${hw.toUpperCase()})` : 'Transcodage (CPU)';
    }
    // Show current resolution if transcoding to a lower quality
    if (activeTrack && playingHeight && src?.height && playingHeight < src.height) {
      videoPlaybackMode += ` → ${playingWidth}x${playingHeight}`;
    }
    // Tone mapping indicator
    if (pi?.tonemapping) {
      videoPlaybackMode += ' (HDR → SDR)';
    }

    // --- Audio ---
    const channelLabel = src?.audioChannelLayout ?? (src?.audioChannels ? `${src.audioChannels}ch` : '');
    const langLabel = src?.audioLanguage ? src.audioLanguage.charAt(0).toUpperCase() + src.audioLanguage.slice(1) : '?';
    const audioCodecUpper = (src?.audioCodec ?? '?').toUpperCase();
    const audioLabel = `${langLabel} ${audioCodecUpper} ${channelLabel}`;

    const audioDetailParts: string[] = [];
    if (src?.audioBitRate) audioDetailParts.push(`${(src.audioBitRate / 1000).toFixed(0)} kbps`);
    if (src?.audioSampleRate) audioDetailParts.push(`${src.audioSampleRate} Hz`);
    const audioDetailLine = audioDetailParts.join('  ') || '?';

    let audioPlaybackMode: string;
    if (effectiveAudioCopy) {
      audioPlaybackMode = 'Lecture directe';
    } else {
      const outCodec = isTranscodeQuality ? 'AAC' : (pi?.outputAudioCodec ?? 'aac').toUpperCase();
      audioPlaybackMode = `Transcoder (${outCodec} 192 kbps)`;
    }

    return {
      container: src?.container ?? '?',
      containerBitrate,
      outputFormat,
      outputBitrate,
      outputFps,
      audioTranscodeNote,
      videoLabel,
      videoProfileLine,
      videoPlaybackMode,
      droppedFrames: shakaStats?.droppedFrames ?? 0,
      audioLabel,
      audioDetailLine,
      audioPlaybackMode,
    };
  });

  async ngAfterViewInit() {
    // On native (Android/iOS), immersive fullscreen: landscape + hide all system bars
    // TODO: read displayBehindNotch from user settings when settings are implemented
    if (this.isNative) {
      (screen.orientation as any)?.lock?.('landscape').catch(() => {});
      Immersive.enter({ displayBehindNotch: true }).catch(() => {});
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
    const resumeTime = qp['t'] ? +qp['t'] : undefined;

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
      // Load media info
      if (this.mediaId) {
        const media = await this.mediaService.getOne(this.mediaId);
        this.media = media;
        this.mediaTitle.set(media.title);
        if (media.fanartUrl) this.fanartUrl.set(media.fanartUrl);

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
        const knownDuration = (file?.streamInfo as any)?.durationSeconds;
        if (knownDuration && knownDuration > 0) {
          this.duration.set(knownDuration);
        }
      }

      // Ask the backend to decide how to play this file
      const deviceProfile = this.deviceProfileService.getProfile();
      this.playbackInfo = await this.streamingApi.getPlaybackInfo(this.mediaFileId, deviceProfile);
      const pi = this.playbackInfo;

      // Map backend decision to our mode signal
      if (pi.playMethod === 'DirectPlay') {
        this.playbackMode.set('direct');
      } else if (pi.playMethod === 'DirectStream') {
        this.playbackMode.set('remux');
      } else {
        this.playbackMode.set('transcode');
      }

      // Use HW accel info from the playback decision
      this.hwAccel.set(pi.hwAccel);

      // object-fit: contain handles aspect ratio via the video's intrinsic dimensions.
      // Do NOT set aspect-ratio CSS — it conflicts with width:100%/height:100% and
      // causes the video to shrink instead of filling the container.

      // Build quality options
      this.buildQualityOptions(pi);

      const mode = this.playbackMode();
      console.log('[Player] mediaFileId:', this.mediaFileId, 'mode:', pi.playMethod,
        'videoCopy:', pi.videoCopyStream, 'audioCopy:', pi.audioCopyStream,
        'reasons:', pi.transcodeReasons.map(r => r.flag).join(', '));

      video.addEventListener('error', () => {
        const e = video.error;
        console.error('[Player] Video error:', e?.code, e?.message);
        this.error.set(e?.message ?? `Video error code ${e?.code}`);
      });

      if (mode === 'direct') {
        // Direct play via shaka (needed for subtitle track support)
        const streamUrl = this.streamingApi.getStreamUrl(this.mediaFileId);
        console.log('[Player] Direct URL:', streamUrl);
        await this.player.load(streamUrl, undefined, 'video/mp4');
      } else {
        // HLS (both remux and transcode use HLS delivery)
        this.player.configure({
          streaming: {
            retryParameters: {
              timeout: 60_000,
              maxAttempts: 5,
              baseDelay: 1000,
            },
          },
          manifest: {
            retryParameters: {
              timeout: 30_000,
              maxAttempts: 5,
              baseDelay: 1000,
            },
          },
        } as any);

        const hlsUrl = this.streamingApi.getHlsUrl(this.mediaFileId);
        console.log('[Player] HLS URL:', hlsUrl);
        await this.player.load(hlsUrl);
      }

      // Load subtitles + auto-select last used language
      await this.loadSubtitles();
      this.loadAudioTracks();
      const savedLang = localStorage.getItem('player.subtitleLang');
      if (savedLang) {
        const match = this.availableSubtitles().find(s => s.language === savedLang);
        if (match) await this.selectSubtitle(match);
      }

      // Resume position
      if (resumeTime) {
        video.currentTime = resumeTime;
      } else {
        try {
          const state = await this.streamingApi.getPlaybackState(this.mediaFileId);
          if (state && !state.completed && state.positionSeconds > 10) {
            video.currentTime = state.positionSeconds;
          }
        } catch {
          // No saved state
        }
      }

      video.play().catch(() => {
        // Autoplay may be blocked
      });

      // Save position every 10 seconds
      this.saveInterval = setInterval(() => this.savePosition(), 10_000);

      // Update stats every second
      this.statsInterval = setInterval(() => {
        // Update active resolution from Shaka's current variant track
        const track = this.player?.getVariantTracks()?.find(t => t.active);
        if (track?.height) {
          this.activeResolution.set(this.resolutionLabel(track.width ?? undefined, track.height));
        }
        if (this.statsVisible()) {
          this.currentTime.set(video.currentTime);
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
      // Auto-enter PiP when user swipes home (Android 12+)
      Pip.setAutoEnter({ enabled: true }).catch(() => {});
    }
  }

  ngOnDestroy() {
    this.savePosition();
    this.stopStreamingSessions();
    this.player?.destroy();
    if (this.saveInterval) clearInterval(this.saveInterval);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.statsInterval) clearInterval(this.statsInterval);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    // Restore system UI when leaving player
    if (this.isNative) {
      screen.orientation?.unlock();
      Immersive.exit().catch(() => {});
      Pip.setAutoEnter({ enabled: false }).catch(() => {});
      window.removeEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
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

  // Player actions (local only — Cast uses CastRemoteComponent)
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
      // Disconnect: resume local playback at Cast position
      const castTime = this.castService.currentTime();
      this.castService.disconnect();
      const video = this.videoEl()?.nativeElement;
      if (video) {
        video.currentTime = castTime;
        video.play().catch(() => {});
      }
    } else {
      // Connect and transfer playback to Cast
      this.castService.requestSession();

      // Wait for connection (poll for up to 30s)
      for (let i = 0; i < 60; i++) {
        if (this.castService.isConnected()) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!this.castService.isConnected()) return;

      // Capture current position BEFORE stopping local playback
      const video = this.videoEl()?.nativeElement;
      const currentPos = video?.currentTime ?? 0;

      // Prepare everything BEFORE unloading (template may switch after unload)
      const castToken = await this.authService.getCastToken();
      const mode = this.playbackMode();
      const qualityId = this.activeQualityId();
      const subtitles = this.availableSubtitles()
        .filter(s => !s.burnIn && s.subtitleDbId)
        .map(s => ({
          url: s.id.startsWith('ext-')
            ? this.streamingApi.getAbsoluteSubtitleUrl(this.mediaFileId, s.subtitleDbId!, castToken)
            : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(this.mediaFileId, parseInt(s.id.replace('emb-', ''), 10), castToken),
          language: s.language,
          label: s.label,
        }));
      // Find active subtitle track ID for Cast (1-based)
      const activeSubId = this.activeSubtitleId();
      let activeTrackId: number | undefined;
      if (activeSubId) {
        const allNonBurnIn = this.availableSubtitles().filter(s => !s.burnIn && s.subtitleDbId);
        const idx = allNonBurnIn.findIndex(s => s.id === activeSubId);
        if (idx >= 0) activeTrackId = idx + 1;
      }

      // Build Cast URL based on current quality selection
      let castUrl: string;
      let contentType: string;
      const lanUrl = this.castService.serverLanUrl() || window.location.origin;
      if (mode === 'direct' || qualityId === 'original') {
        castUrl = this.streamingApi.getAbsoluteStreamUrl(this.mediaFileId, castToken);
        contentType = 'video/mp4';
      } else if (qualityId === 'auto') {
        castUrl = this.streamingApi.getAbsoluteHlsUrl(this.mediaFileId, castToken);
        contentType = 'application/x-mpegurl';
      } else {
        // Specific quality variant
        castUrl = `${lanUrl}/api/stream/${this.mediaFileId}/${qualityId}/index.m3u8?token=${encodeURIComponent(castToken)}`;
        contentType = 'application/x-mpegurl';
      }

      // Stop local playback (pause + mute, don't unload — keep Shaka alive for reconnect)
      if (video) {
        video.pause();
        video.muted = true;
      }

      // Send to Chromecast
      await this.castService.loadMedia({
        url: castUrl,
        contentType,
        title: this.mediaTitle(),
        subtitle: this.episodeTitle() || undefined,
        posterUrl: this.fanartUrl() ?? undefined,
        currentTime: currentPos,
        subtitles,
        activeSubtitleTrackId: activeTrackId,
      });
    }
  }

  onDisconnectCast() {
    const castTime = this.castService.currentTime();
    this.castService.disconnect();
    // Resume local — Shaka is still loaded, just muted+paused
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.muted = false;
      video.currentTime = castTime;
      video.play().catch(() => {});
    }
  }

  /** Handle quality change from Cast remote — reload stream with specific variant URL */
  /** Handle audio track change from Cast remote — reload stream with different audio */
  async onCastAudioChange(audioIndex: number) {
    // Tell backend to use this audio stream
    const deviceProfile = this.deviceProfileService.getProfile();
    await this.streamingApi.getPlaybackInfo(
      this.mediaFileId, deviceProfile, this.activeBurnInId ?? undefined, audioIndex,
    );
    // Stop old sessions
    this.stopStreamingSessions();

    // Reload Cast with new stream
    const castToken = await this.authService.getCastToken();
    const currentPos = this.castService.currentTime();
    const qualityId = this.activeQualityId();
    const lanUrl = this.castService.serverLanUrl() || window.location.origin;

    let castUrl: string;
    let contentType: string;
    if (qualityId === 'auto') {
      castUrl = this.streamingApi.getAbsoluteHlsUrl(this.mediaFileId, castToken);
      contentType = 'application/x-mpegurl';
    } else if (qualityId === 'original') {
      castUrl = this.streamingApi.getAbsoluteStreamUrl(this.mediaFileId, castToken);
      contentType = 'video/mp4';
    } else {
      castUrl = `${lanUrl}/api/stream/${this.mediaFileId}/${qualityId}/index.m3u8?token=${encodeURIComponent(castToken)}`;
      contentType = 'application/x-mpegurl';
    }

    const subtitles = this.availableSubtitles()
      .filter(s => !s.burnIn && s.subtitleDbId)
      .map(s => ({
        url: s.id.startsWith('ext-')
          ? this.streamingApi.getAbsoluteSubtitleUrl(this.mediaFileId, s.subtitleDbId!, castToken)
          : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(this.mediaFileId, parseInt(s.id.replace('emb-', ''), 10), castToken),
        language: s.language,
        label: s.label,
      }));

    await this.castService.loadMedia({
      url: castUrl,
      contentType,
      title: this.mediaTitle(),
      subtitle: this.episodeTitle() || undefined,
      posterUrl: this.fanartUrl() ?? undefined,
      currentTime: currentPos,
      subtitles,
    });
  }

  async onCastQualityChange(qualityId: string) {
    const castToken = await this.authService.getCastToken();
    const currentPos = this.castService.currentTime();

    let castUrl: string;
    if (qualityId === 'auto') {
      // Master playlist — let Chromecast ABR decide
      castUrl = this.streamingApi.getAbsoluteHlsUrl(this.mediaFileId, castToken);
    } else if (qualityId === 'original') {
      // Direct stream
      castUrl = this.streamingApi.getAbsoluteStreamUrl(this.mediaFileId, castToken);
    } else {
      // Specific quality variant — build the variant playlist URL directly
      const lanUrl = this.castService.serverLanUrl() || window.location.origin;
      castUrl = `${lanUrl}/api/stream/${this.mediaFileId}/${qualityId}/index.m3u8?token=${encodeURIComponent(castToken)}`;
    }

    const subtitles = this.availableSubtitles()
      .filter(s => !s.burnIn && s.subtitleDbId)
      .map(s => ({
        url: s.id.startsWith('ext-')
          ? this.streamingApi.getAbsoluteSubtitleUrl(this.mediaFileId, s.subtitleDbId!, castToken)
          : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(this.mediaFileId, parseInt(s.id.replace('emb-', ''), 10), castToken),
        language: s.language,
        label: s.label,
      }));

    const contentType = qualityId === 'original' ? 'video/mp4' : 'application/x-mpegurl';

    await this.castService.loadMedia({
      url: castUrl,
      contentType,
      title: this.mediaTitle(),
      subtitle: this.episodeTitle() || undefined,
      posterUrl: this.fanartUrl() ?? undefined,
      currentTime: currentPos,
      subtitles,
    });
  }

  /** Handle burn-in subtitle selection from Cast remote */
  async onCastBurnIn(subtitleDbId: number | null) {
    if (!subtitleDbId) {
      // Disable burn-in: reload stream without subtitle
      this.activeBurnInId = null;
      await this.reloadCastStream();
      return;
    }
    // Reload stream with burn-in subtitle
    this.activeBurnInId = subtitleDbId;
    await this.reloadCastStream();
  }

  private async reloadCastStream() {
    const castToken = await this.authService.getCastToken();
    const mode = this.playbackMode();
    const hlsUrl = this.streamingApi.getAbsoluteHlsUrl(this.mediaFileId, castToken);
    const streamUrl = this.streamingApi.getAbsoluteStreamUrl(this.mediaFileId, castToken);

    // Re-fetch playback info with burn-in
    const deviceProfile = this.deviceProfileService.getProfile();
    await this.streamingApi.getPlaybackInfo(
      this.mediaFileId, deviceProfile, this.activeBurnInId ?? undefined,
    );

    // Build subtitle list (only non-burn-in for sidecar, absolute URLs)
    const subtitles = this.availableSubtitles()
      .filter(s => !s.burnIn && s.subtitleDbId)
      .map(s => ({
        url: s.id.startsWith('ext-')
          ? this.streamingApi.getAbsoluteSubtitleUrl(this.mediaFileId, s.subtitleDbId!, castToken)
          : this.streamingApi.getAbsoluteEmbeddedSubtitleUrl(this.mediaFileId, parseInt(s.id.replace('emb-', ''), 10), castToken),
        language: s.language,
        label: s.label,
      }));

    const currentPos = this.castService.currentTime();
    await this.castService.loadMedia({
      url: mode === 'direct' ? streamUrl : hlsUrl,
      contentType: mode === 'direct' ? 'video/mp4' : 'application/x-mpegurl',
      title: this.mediaTitle(),
      subtitle: this.episodeTitle() || undefined,
      posterUrl: this.fanartUrl() ?? undefined,
      currentTime: currentPos,
      subtitles,
    });
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

        if (sub.filePath) {
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
          });
        }
      }

      this.availableSubtitles.set(options);
    } catch {
      // Ignore subtitle loading errors
    }
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
          }));
          this.availableAudioTracks.set(tracks);
          this.activeAudioTrackId.set(tracks[0].id);
        }
        return;
      }

      const tracks = Array.from(seen.entries()).map(([audioId, v]) => ({
        id: `shaka-${audioId}`,
        label: `${v.language ?? 'und'} (${v.audioCodec ?? '?'}${v.channelsCount ? ' ' + v.channelsCount + 'ch' : ''})`,
      }));

      this.availableAudioTracks.set(tracks);
      // Set active to the currently playing one
      const active = variants.find((v: any) => v.active);
      if (active?.audioId != null) {
        this.activeAudioTrackId.set(`shaka-${active.audioId}`);
      }
    }, 2000);
  }

  private activeAudioStreamIndex: number | undefined;

  async onSelectAudioTrack(trackId: string) {
    this.activeAudioTrackId.set(trackId);

    // Extract the audio stream index (relative index in the audio streams array)
    const idx = parseInt(trackId.replace(/^(shaka-|si-)/, ''), 10);
    this.activeAudioStreamIndex = idx;

    // Reload the stream with the new audio track
    await this.reloadStream();
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    if (!this.player) return;

    if (!sub) {
      try { (this.player as any).setTextVisibility(false); } catch {};
      this.activeSubtitleId.set(null);
      this.subtitlePickerOpen.set(false);
      localStorage.setItem('player.subtitleLang', '');
      // If burn-in was active, reload stream without it
      if (this.activeBurnInId) {
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
      await this.reloadStream();
      return;
    }

    try {
      // Client-side: add text track via Shaka
      if (this.activeBurnInId) {
        this.activeBurnInId = null;
        await this.reloadStream();
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
    const video = this.videoEl()?.nativeElement;
    if (!video || !this.mediaId || !video.currentTime) return;
    try {
      const dur = isFinite(video.duration) ? video.duration : this.duration();
      await this.streamingApi.updatePlaybackState(this.mediaFileId, {
        positionSeconds: video.currentTime,
        durationSeconds: dur || 0,
        mediaId: this.mediaId,
        episodeId: this.episodeId,
      });
    } catch {
      // Ignore save errors
    }
  }

  private onPipModeChanged = (e: Event) => {
    const isInPip = (e as CustomEvent).detail?.isInPipMode ?? false;
    this.inPipMode.set(isInPip);
    if (!isInPip) {
      // Exiting PiP: restore immersive mode
      Immersive.enter({ displayBehindNotch: true }).catch(() => {});
    }
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

    const mode = this.playbackMode();
    if (mode === 'direct') {
      await this.player.load(this.streamingApi.getStreamUrl(this.mediaFileId), currentPos, 'video/mp4');
    } else {
      await this.player.load(this.streamingApi.getHlsUrl(this.mediaFileId), currentPos);
    }

    video.play().catch(() => {});
  }

  onToggleQualityPicker() {
    this.qualityPickerOpen.set(!this.qualityPickerOpen());
    this.subtitlePickerOpen.set(false);
  }

  async selectQuality(option: QualityOption) {
    this.qualityPickerOpen.set(false);
    if (option.id === this.activeQualityId()) return;
    this.activeQualityId.set(option.id);

    if (!this.player) return;

    if (option.id === 'auto') {
      // Re-enable ABR
      this.player.configure({ abr: { enabled: true } } as any);
      return;
    }

    // Disable ABR and lock to a specific variant
    this.player.configure({ abr: { enabled: false } } as any);
    const tracks = this.player.getVariantTracks();
    if (!tracks.length) return;

    if (option.id === 'original') {
      // Pick the highest resolution track (original/remux quality)
      const best = tracks.reduce((a, b) => ((a.height ?? 0) >= (b.height ?? 0) ? a : b));
      this.player.selectVariantTrack(best, true);
    } else {
      // Find the track closest to the requested height
      const target = option.height;
      const match = tracks.reduce((a, b) =>
        Math.abs((a.height ?? 0) - target) <= Math.abs((b.height ?? 0) - target) ? a : b,
      );
      this.player.selectVariantTrack(match, true);
    }
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
      options.push({ id: 'original', label: `Original (${resLabel})`, height: srcH });
    } else {
      // Original (remux) if video can be copied
      if (pi.videoCopyStream) {
        const resLabel = this.resolutionLabel(srcW, srcH);
        options.push({ id: 'original', label: `Original (${resLabel})`, height: srcH });
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
      for (const p of profiles) {
        if (srcW >= p.minWidth) {
          options.push(p);
        }
      }
    }

    this.availableQualities.set(options);
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

  private formatTime(seconds: number): string {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}
