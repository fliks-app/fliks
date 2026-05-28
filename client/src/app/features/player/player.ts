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
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
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
import {
  CastPlayerService,
  CastAudioOption,
  buildCastAudioOptions,
  buildCastQualityOptions,
} from '../../core/services/cast-player.service';
import { CastSettingsService } from '../../core/services/cast-settings.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { ToastService } from '../../core/services/toast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { formatAudioLabel, parseAudioIndex, SpriteMetadata, widthForProfile } from '../../core/utils/player.utils';
import {
  PlayerSettingsService, normalizeLang,
  SUBTITLE_SIZE_MAP, SUBTITLE_COLOR_MAP, SUBTITLE_SHADOW_MAP, SUBTITLE_BG_MAP,
} from '../../core/services/player-settings.service';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { ShakaEngine } from '../../core/services/playback-engine/shaka-engine';
import { TizenEngine, isTizenAvplayAvailable } from '../../core/services/playback-engine/tizen-engine';
import { NativePlayer } from '../../core/plugins/native-player.plugin';
import { NativeEngine } from '../../core/services/playback-engine/native-engine';
import { PlayerStateService } from '../../core/services/player-state.service';
import { TrackManagerService, SubtitleOption } from '../../core/services/track-manager.service';
import { QualityManagerService, findVariantByProfileName, findBestVariantForHeight } from '../../core/services/quality-manager.service';
import { DeviceService } from '../../core/services/device.service';

interface ImmersivePlugin {
  enter(options?: { displayBehindNotch?: boolean }): Promise<void>;
  exit(): Promise<void>;
  setLightStatusBar(options: { light: boolean }): Promise<void>;
}
const Immersive = registerPlugin<ImmersivePlugin>('Immersive');

interface PipPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  enter(): Promise<void>;
  setAutoEnter(options: { enabled: boolean }): Promise<void>;
  updatePlaybackState(options: { playing: boolean }): Promise<void>;
}
const Pip = registerPlugin<PipPlugin>('Pip');

import { LucideCircleAlert, LucideInfo, LucideX } from '@lucide/angular';
import { PlayerControlsComponent } from './controls/player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './overlay/player-stats-overlay';

@Component({
  imports: [TranslateModule, LucideCircleAlert, LucideInfo, LucideX, PlayerControlsComponent, PlayerStatsOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player.html',
  encapsulation: ViewEncapsulation.None,
  styles: [`
    .player-container {
      position: fixed;
      /* 'inset: 0' pins all four edges to the layout viewport. On iOS
         Safari with the bottom URL bar, the layout viewport ignores the
         chrome so 'bottom: 0' lands BEHIND it — explicit 'height: 100dvh'
         caps the container to the visible (dynamic) viewport and pulls
         the seekbar above the URL bar. '100vh' is the legacy fallback for
         browsers without dvh support (Tizen Chrome 85 — no URL bar). */
      inset: 0;
      height: 100vh;
      height: 100dvh;
      background-color: #000;
      z-index: 100;
      overflow: hidden;
      -webkit-user-select: none;
      user-select: none;
      /* iOS WKWebView rotation fix: force GPU compositing so WebKit
         recalculates the fixed position after orientation change. */
      -webkit-transform: translateZ(0);
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
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      /* Override Tailwind preflight's max-width:100%/height:auto for
       * video: it leaves the element at its intrinsic size when the
       * container grows beyond the decoded frame's natural width,
       * which surfaces as black bars on all four sides instead of
       * letterboxing on the short axis only. The !important here only
       * has to beat preflight (specificity 0,0,0 via :where) so it's
       * cheap. */
      max-width: none !important;
      max-height: none !important;
    }
    /* Lift native subtitles by the user's configured bottom margin
       (--cue-bottom-margin, set per-video by applySubtitleStyle), and bump
       another 5vh when the controls bar is visible so cues clear it. We
       toggle the class directly on the <video> — toggling on an ancestor
       isn't always enough to trigger a style recalc on UA-shadow
       pseudo-elements in Chromium. WebKit pseudo covers Chromium + Safari
       + WKWebView, which is what we target. */
    .player-video::-webkit-media-text-track-display {
      transition: transform 200ms ease;
      transform: translateY(calc(-1 * var(--cue-bottom-margin, 0vh)));
    }
    .player-video.controls-visible::-webkit-media-text-track-display {
      transform: translateY(calc(-1 * var(--cue-bottom-margin, 0vh) - 15vh));
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
  private readonly castSettings = inject(CastSettingsService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly navHistory = inject(NavigationHistoryService);
  private readonly toast = inject(ToastService);
  private readonly navbar = inject(NavbarService);
  private readonly translate = inject(TranslateService);

  // New extracted services
  private readonly state = inject(PlayerStateService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly qualityManager = inject(QualityManagerService);
  readonly device = inject(DeviceService);

  /** Reset the singleton PlayerStateService synchronously at field-init
   *  time so that effects declared further down (e.g. `autoHideOnPlay`)
   *  don't see lingering `videoStarted=true` / `paused=false` from the
   *  previous session. `state.reset()` is also called in
   *  `ngAfterViewInit` but that happens after the first effect pass. */
  private readonly _stateReset = (this.state.reset(), null);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');

  /** Active engine (Shaka for web HLS, Native for Android/iOS). Cast
   *  bypasses the engine abstraction and is driven by `castPlayerService`
   *  + `castService` directly. */
  private engine: PlaybackEngine | null = null;
  readonly isNativeEngine = signal(false);
  /** True when AVPlay (Samsung TV native HW decoder) is driving playback —
   *  same UX treatment as a Capacitor native engine: the WebView paints on
   *  top of a transparent layer above the hardware video surface. */
  readonly isTizenEngine = signal(false);
  /** Tizen WebApp running on a Samsung TV with AVPlay available. Distinct
   *  from `isNative` (Capacitor) and from `device.isTv()` (which is true
   *  on any TV form factor including the placeholder browser preview). */
  readonly isTizen = isTizenAvplayAvailable();

  /** Template binding — true when using native (ExoPlayer/AVPlayer) engine. */
  get nativeEngine(): boolean {
    return this.isNativeEngine();
  }

  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private controlsTimeout: ReturnType<typeof setTimeout> | null = null;
  private seekDragging = false;
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
  /** Label for the currently picked quality, mirroring the per-rung
   *  label in the dropdown (`q.label`) — so the header row stays in
   *  sync with the list and never surfaces internal ids like
   *  `1080p-hdr`. Falls back to the id for legacy callers. */
  readonly activeQualityLabel = computed(() => {
    const id = this.activeQualityId();
    if (id === 'auto') {
      const res = this.activeResolution();
      return res ? `Auto (${res})` : 'Auto';
    }
    return this.availableQualities().find((q) => q.id === id)?.label ?? id;
  });

  // Component-owned signals (not delegated)
  readonly playbackRate = signal(1);
  /** Controls start visible everywhere — the user is staring at a
   *  paused / loading frame and expects to see the affordances. A
   *  dedicated effect (see `playbackVisibilityEffect`) flips them
   *  off the moment playback actually starts, and the auto-hide
   *  timer takes over from there during the rest of the session. */
  readonly controlsVisible = signal(true);
  readonly inPipMode = signal(false);
  readonly pipAvailable = signal(true);
  private readonly isLandscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);
  readonly statsVisible = signal(false);
  readonly fillScreen = signal(false);
  private readonly statsRefreshTick = signal(0);
  readonly subtitlePickerOpen = signal(false);
  readonly qualityPickerOpen = signal(false);
  /** True when any panel inside <app-player-controls> (desktop dropdown or
   *  mobile bottom sheet) is open — suspends the auto-hide timer. */
  private readonly controlsPanelOpen = signal(false);

  // ── Skip-intro state ──
  /** Episode-level intro marker received in playback-info (null for movies / no marker). */
  readonly introMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Outro / end-credits marker — drives the "Épisode suivant" floating button. */
  readonly outroMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Embedded chapters from playback-info (MKV/MP4). */
  readonly chapters = signal<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  /** Set after a manual seek to suppress auto-skip for a short window. */
  private autoSkipSuppressedUntil = 0;
  /** Tracks last episodeId we auto-skipped for to ensure we only auto-skip once per session. */
  private autoSkipFiredForEpisode: number | null = null;
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<{ id: string; label: string; language: string }[]>([]);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);

  /** Audio tracks from streamInfo for the Cast remote */
  readonly castAudioOptions = computed<CastAudioOption[]>(() => {
    const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
    return buildCastAudioOptions(file?.streamInfo?.audio, this.translate);
  });

  /** True on every standalone bundle (Capacitor + Smart TV). Drives the
   *  controls bar: fullscreen toggle hidden, PiP toggle hidden, dpad-
   *  friendly defaults. Sourced from ServerConfigService so the rule
   *  matches the rest of the app instead of probing Capacitor directly. */
  readonly isNative = this.serverConfig.isNative;

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

  // Admin message overlay — rendered inside the player container so it stays
  // visible in browser fullscreen (the global toast layer sits outside the
  // fullscreened element and gets clipped).
  readonly adminMessage = signal<string | null>(null);
  private adminMessageTimer: ReturnType<typeof setTimeout> | null = null;

  private showAdminMessage(text: string) {
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    this.adminMessage.set(text);
    this.adminMessageTimer = setTimeout(() => this.adminMessage.set(null), 6000);
  }

  dismissAdminMessage() {
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    this.adminMessageTimer = null;
    this.adminMessage.set(null);
  }

  // Remote control: listen for admin commands via SSE
  private readonly remoteCommandEffect = effect(() => {
    const event = this.sseService.lastEvent();
    if (!event || event.type !== 'player.command') return;
    const cmd = event as any;
    const currentUserId = this.authService.user()?.id;
    if (cmd.mediaFileId !== this.mediaFileId || cmd.userId !== currentUserId) return;

    if (cmd.action === 'message') {
      const text = (cmd.message as string)?.trim();
      if (text) this.showAdminMessage(text);
      return;
    }

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

  /** Hide the controls bar the moment the first frame of the new
   *  session is painted. Uses `videoStarted` (per-session, set after
   *  the engine actually surfaces a frame) rather than `paused` —
   *  the `paused` signal is on a singleton service, so opening a
   *  second video would inherit `paused = false` from the previous
   *  session and the effect would fire before this video has even
   *  loaded.
   *  `controlsVisible` is read through `untracked` so the effect
   *  only reacts to videoStarted transitions — without it, the
   *  user moving the mouse (which calls `showControls()`) would
   *  re-fire this effect and re-hide them immediately, making the
   *  cursor / bar impossible to keep visible. Subsequent pause /
   *  resume cycles fall through to the existing auto-hide timer +
   *  user-interaction reveal. */
  private readonly autoHideOnPlayEffect = effect(() => {
    if (this.videoStarted() && untracked(() => this.controlsVisible())) {
      this.controlsVisible.set(false);
    }
  });

  /** Re-apply native subtitle style on controls show/hide so the bottom-margin
      bump kicks in. Browser playback uses CSS instead — see styles below. */
  private readonly subtitleControlsMarginEffect = effect(() => {
    this.controlsVisible();
    if (this.isNativeEngine() && this.engine) {
      this.applyNativeSubtitleStyle();
    }
  });

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
  private isOfflinePlayback = false;
  private episodeId: number | undefined;
  private media: Media | null = null;
  /** Bumped whenever {@link media} is (re)assigned so reactive computeds re-run. */
  private readonly mediaLoadedTick = signal(0);
  private activeBurnInId: number | null = null;
  private activeAudioStreamIndex: number | undefined;

  readonly mediaTitle = signal('');
  readonly episodeTitle = signal('');
  readonly fanartUrl = signal<string | null>(null);

  /** Low-quality variant of `fanartUrl` for the loading backdrop's
   *  LQIP layer. Only kicks in for our own `/api/images/...` URLs
   *  (which support `?size=thumb`); remote / data URLs fall through
   *  as-is so the layer paints the same image as the full-res one. */
  readonly fanartThumbUrl = computed(() => {
    const url = this.fanartUrl();
    if (!url) return null;
    if (!url.includes('/api/images/')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}size=thumb`;
  });
  private playbackInfo: PlaybackInfoResponse | null = null;

  /** Live-session id to bind the next stream request to. While casting
   *  the receiver's session id wins (its segments come from a separate
   *  ffmpeg job under the cast device profile); otherwise the local
   *  browser's session id. */
  private activeSessionId(): string | undefined {
    if (this.castService.isConnected()) {
      return (
        this.castPlayerService.liveSessionId() ?? this.playbackInfo?.sessionId
      );
    }
    return this.playbackInfo?.sessionId;
  }

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

    // Letterbox crop detected at import time (ffprobe `cropdetect`).
    // The transcode pipeline cuts these bars on every cropped session;
    // surfacing the rectangle in the overlay lets the user see why
    // the output resolution doesn't match the source.
    const cropLine = src?.crop
      ? `${src.crop.width}x${src.crop.height} (offset ${src.crop.x},${src.crop.y})`
      : '';

    // --- Video label ---
    // Use profile name from active variant URL (e.g. "360p") instead of raw resolution
    const active = this.getActiveVariant();
    const urlMatch = active?.originalVideoId?.match(/\/(\d+p)\//);
    const resLabel = urlMatch?.[1]
      ?? this.qualityManager.resolutionLabel(playingWidth, playingHeight);
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
      const tier = urlMatch?.[1] ?? this.qualityManager.transcodeTierFromVariantHeight(activeVariant?.height ?? 0, activeVariant?.width);
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
      const hwLabel: Record<string, string> = { qsv: 'QSV', vaapi: 'VAAPI', nvenc: 'NVENC', videotoolbox: 'Apple VT', none: 'CPU' };
      videoPlaybackMode = `Transcoding (${hwLabel[hw] ?? hw.toUpperCase()})`;
    }
    if (playingHeight && src?.height && playingHeight < src.height) {
      videoPlaybackMode += ` \u2192 ${playingWidth}x${playingHeight}`;
    }

    // Tonemapping line. Show the ACTUALLY-used filter (post `auto`
    // resolution + opencl-probe fallback), not the admin pick \u2014 when
    // the boot probe failed, `auto` becomes `vaapi` even if the admin
    // setting says `auto`/`opencl`. Source of truth is `pi.tonemapAlgo`
    // set by the backend in playback-info.
    const tonemapLabel: Record<string, string> = {
      vaapi: 'tonemap_vaapi',
      opencl: 'tonemap_opencl',
      qsv: 'vpp_qsv tonemap',
    };
    const tonemapping =
      pi?.tonemapping && pi?.tonemapAlgo
        ? (tonemapLabel[pi.tonemapAlgo] ?? pi.tonemapAlgo)
        : pi?.tonemapping
          ? 'enabled'
          : '';

    // Split transcode-reason flags by what they actually re-encode so
    // each section's "Reasons" line only shows what's relevant to it.
    // Video re-encode triggers: any `Video*` flag plus `SubtitleBurnIn`
    // (which composites text frames into the video stream). Audio
    // re-encode triggers: any `Audio*` flag. `Container*` is intentionally
    // excluded \u2014 it's a packaging-level reason that already shows up in
    // the "\u2192 HLS" line of the stream section, and it doesn't tell you
    // anything about why this codec specifically had to change.
    const allFlags = (pi?.transcodeReasons ?? []).map((r) => r.flag);
    const videoTranscodeReasons = effectiveVideoCopy
      ? []
      : allFlags.filter((f) => f.startsWith('Video') || f === 'SubtitleBurnIn');
    const audioTranscodeReasons = effectiveAudioCopy
      ? []
      : allFlags.filter((f) => f.startsWith('Audio'));

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
      videoLabel,
      videoStreamBitrate,
      videoProfileLine,
      videoPlaybackMode,
      crop: cropLine,
      tonemapping,
      videoTranscodeReasons,
      droppedFrames: engineStats?.droppedFrames ?? 0,
      audioLabel,
      audioStreamBitrate,
      audioDetailLine,
      audioPlaybackMode,
      audioTranscodeReasons,
    };
  });

  // ── Lifecycle ──

  async ngAfterViewInit() {
    this.state.reset();

    // On native: listen to orientation changes (immersive handled by effect)
    if (this.isNative) {
      screen.orientation?.addEventListener('change', this.onOrientationChange);
    }

    // Eager backdrop from router state — set BEFORE any await so the
    // loading screen renders on the first tick instead of popping in
    // only after the media API + image download (~1s+ later). The
    // image is already in the browser cache from the source tile/header.
    // `stillUrl` (episode thumbnail) wins over `fanartUrl` when both
    // are passed: a series viewer recognises the episode they just
    // selected, not the show's hero.
    const navState = (this.router.getCurrentNavigation()?.extras?.state ?? history.state) as { fanartUrl?: string | null; stillUrl?: string | null } | null;
    const eagerBackdrop = navState?.stillUrl ?? navState?.fanartUrl;
    if (eagerBackdrop) {
      this.fanartUrl.set(this.serverConfig.resolveUrl(eagerBackdrop));
    }

    const qp = this.route.snapshot.queryParams;
    this.mediaFileId = +this.route.snapshot.params['mediaFileId'];
    this.mediaId = qp['mediaId'] ? +qp['mediaId'] : 0;
    this.episodeId = qp['episodeId'] ? +qp['episodeId'] : undefined;
    const resumeTime = 't' in qp ? +qp['t'] : undefined;

    // Subtitle loading promise — started early for Shaka path, resolved later
    let subsPromise: Promise<any[]> | null = null;

    try {
      // Only use offline playback if explicitly requested via query param
      let offlineCheck: string | null = null;
      if (qp['offline'] === '1') {
        offlineCheck = await this.offlineStorage.getLocalUrl(`download-${this.mediaFileId}`).catch(() => null);
        if (!offlineCheck) {
          this.state.error.set('Contenu offline introuvable. Re-téléchargez le média.');
          return;
        }
        this.isOfflinePlayback = true;
      }

      // Kick off playback-info in parallel with media/state load to save one
      // serial round-trip. preselectedAudioIndex is passed as undefined since
      // we don't have the file's audio streams yet; users with a saved audio
      // language preference may land on the backend's default audio on first
      // play of a file and trigger the existing audio-switch reload if they
      // change it — same flow as switching audio mid-playback.
      // startQuality/startAt let the backend pre-spawn ffmpeg right here
      // (instead of waiting for master.m3u8), overlapping encoder init with
      // the ~100–300ms gap before the player fetches the playlist.
      const deviceProfile = this.deviceProfileService.getProfile();
      const savedQualityId = this.activeQualityId();
      const prewarmQuality = savedQualityId !== 'auto' ? savedQualityId : undefined;
      const prewarmStartAt = resumeTime;
      const playbackInfoPromise = this.isOfflinePlayback
        ? null
        : this.streamingApi.getPlaybackInfo(
            this.mediaFileId,
            deviceProfile,
            undefined,
            undefined,
            prewarmQuality,
            prewarmStartAt,
          );

      // Load media info + playback state in parallel
      // No stopSessions here — getOrCreateSession handles stale sessions naturally
      let startTime: number | undefined = resumeTime ?? undefined;
      if (this.mediaId && !this.isOfflinePlayback) {
        const [media, playbackState] = await Promise.all([
          this.mediaService.getOne(this.mediaId),
          startTime == null
            ? this.streamingApi.getPlaybackState(this.mediaId, this.episodeId).catch(() => null)
            : Promise.resolve(null),
        ]);

        this.media = media;
        this.mediaLoadedTick.update(v => v + 1);
        this.mediaTitle.set(media.title);
        if (media.fanartUrl) this.fanartUrl.set(this.serverConfig.resolveUrl(media.fanartUrl));

        const file = media.files?.find((f: any) => f.id === this.mediaFileId);
        if (this.episodeId && media.seasons) {
          for (const season of media.seasons) {
            const ep = season.episodes?.find(e => e.id === this.episodeId);
            if (ep) {
              const label = `S${season.seasonNumber}:E${ep.episodeNumber}`;
              this.episodeTitle.set(ep.title ? `${label} - ${ep.title}` : label);
              // Prefer the episode still (full quality stored locally
              // by ImageService.downloadAndStore('episode', ...)) over
              // the series fanart so the loading backdrop matches
              // exactly what's about to play.
              if (ep.stillUrl) {
                this.fanartUrl.set(this.serverConfig.resolveUrl(ep.stillUrl));
              }
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

        // Resume position from playback state
        if (startTime == null && playbackState && !playbackState.completed && playbackState.positionSeconds > 10) {
          startTime = playbackState.positionSeconds;
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

      if (this.isOfflinePlayback) {
        this.state.playbackMode.set('direct');
        this.qualityManager.availableQualities.set([]);

        if (this.isNative) {
          // Android: ExoPlayer with CacheDataSource (offline HLS from cache)
          await this.createNativeEngine();
          (this.engine as NativeEngine).setOffline(true);
          this.applyNativeSubtitleStyle();

          // Pre-load offline subtitles so they're included in ExoPlayer's MediaItem
          const offlineSubs = await this.getOfflineSubtitleConfigs();
          if (offlineSubs.length) {
            (this.engine as NativeEngine).setPreloadedSubtitles(offlineSubs);
          }

          await this.engine!.load(offlineCheck!, startTime, 'application/x-mpegURL');
        } else {
          // Web: Shaka offline URI ("offline:123") — IndexedDB-backed
          await this.createShakaEngine();
          await this.engine!.load(offlineCheck!, startTime);
        }
      } else {
        // Pre-compute audio preference (for UI/state only — the backend
        // already picked an audio during the parallel playback-info call).
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        const audioStreams: { language?: string }[] = (file?.streamInfo as any)?.audio ?? [];
        const preselectedAudioIndex = this.playerSettings.resolveAudioStreamIndex(
          this.mediaFileId, audioStreams, this.mediaId,
        );
        this.activeAudioStreamIndex = preselectedAudioIndex;

        // Await playback-info (kicked off in parallel with media load above)
        this.playbackInfo = await playbackInfoPromise!;
        const pi = this.playbackInfo;
        this.introMarker.set(pi.markers?.intro ?? null);
        this.outroMarker.set(pi.markers?.outro ?? null);
        this.chapters.set(pi.chapters ?? []);

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

        // Make sure a fresh long-lived stream JWT (12h) is cached before
        // we build the manifest/segment URLs and the Bearer headers
        // passed to ExoPlayer / AVPlay / Shaka. Those engines bake auth
        // at \`load()\` and never re-ask Angular for a fresh credential —
        // the regular 1h access token would expire mid-film.
        await this.authService.ensureStreamToken();

        // ── Engine selection ──
        // Native (Capacitor) always goes through the platform player —
        // ExoPlayer on Android (incl. TV), AVPlayer on iOS. They beat the
        // WebView's HTMLMediaElement on every axis we care about: HW
        // decoding, HEVC/AV1 support, HDR, Atmos passthrough, lower latency.
        // Samsung Tizen goes through AVPlay for the same reasons (HW HEVC/
        // AV1, Dolby Atmos passthrough, transparent video surface behind
        // the WebView — Shaka chokes on Tizen 6.5 MSE: e.g. EAC3 audio
        // claims support but `addSourceBuffer` throws).
        // Web (browser) keeps the Shaka path.
        if (this.isTizen) {
          await this.createTizenEngine();

          // Subtitle fetch in parallel with engine load — AVPlay's
          // `setExternalSubtitlePath` waits for the player to be in
          // READY/PLAYING state, so we load(...) first, then attach
          // the active subtitle after prepareAsync resolves.
          const tizenSubsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          const token =
            this.authService.streamToken() ?? this.authService.accessToken;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

          if (mode === 'direct') {
            const streamUrl = this.streamingApi.getStreamUrl(
              this.mediaFileId,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(streamUrl, startTime, 'video/mp4', headers);
          } else {
            const savedQualityId = this.activeQualityId();
            const tvStartQuality = savedQualityId !== 'auto' ? savedQualityId : undefined;
            const hlsUrl = this.streamingApi.getHlsUrl(
              this.mediaFileId,
              tvStartQuality,
              startTime,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(hlsUrl, startTime, undefined, headers);
          }

          // Subtitles loaded — expose to the picker. The full auto-pick
          // path (remembered selection, language match, forced subs) is
          // shared with native/Shaka further down, via `autoSelectSubtitle`.
          const subs = await tizenSubsPromise;
          this.availableSubtitles.set(subs);
          await this.trackManager.autoSelectSubtitle(
            subs,
            this.availableAudioTracks(),
            this.activeAudioTrackId(),
            this.mediaFileId,
            async (sub) => {
              if (!sub) return;
              this.engine!.selectTextTrack(sub);
              this.activeSubtitleId.set(sub.id);
            },
            this.mediaId,
          );
        } else if (this.isNative) {
          // Start subtitle fetch in parallel with native engine creation so
          // the network round-trip doesn't block ExoPlayer's init.
          const nativeSubsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          await this.createNativeEngine();

          this.applyNativeSubtitleStyle();

          // Await subs before building the ExoPlayer MediaItem (preloaded
          // subs avoid a rebuild). Likely already resolved by this point.
          const subs = await nativeSubsPromise;
          this.availableSubtitles.set(subs);
          const nonBurnInSubs = subs
            .filter((s) => !s.burnIn && s.url)
            .map((s) => ({ url: s.url, language: s.language, label: s.label }));
          (this.engine as NativeEngine).setPreloadedSubtitles(nonBurnInSubs);

          const token =
            this.authService.streamToken() ?? this.authService.accessToken;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

          if (mode === 'direct') {
            // Progressive MP4 — Media3 detects the container, no quality
            // ladder to constrain (DirectPlay = single source variant).
            const streamUrl = this.streamingApi.getStreamUrl(
              this.mediaFileId,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(streamUrl, startTime, 'video/mp4', headers);
          } else {
            // HLS transcode/remux — apply quality constraint before load to
            // stop ExoPlayer from picking 4K on a phone (slow transcode →
            // A/V desync). `auto`: no constraint, ExoPlayer's ABR picks
            // adaptively. `original`: pin to source dimensions so ABR
            // can't downgrade (the user explicitly forced top quality).
            // Specific rung: pin to that rung's width/height.
            const savedQualityId = this.activeQualityId();
            if (savedQualityId !== 'auto') {
              let w: number;
              let h: number;
              if (savedQualityId === 'original') {
                w = this.playbackInfo?.source?.width ?? 3840;
                h = this.playbackInfo?.source?.height ?? 2160;
              } else {
                w = widthForProfile(savedQualityId) ?? 1920;
                h = this.qualityManager.availableQualities()
                  .find(q => q.id === savedQualityId)?.height ?? 1080;
              }
              (this.engine as NativeEngine).selectVariantTrack({ width: w, height: h });
            }
            const nativeStartQuality = savedQualityId !== 'auto' ? savedQualityId : undefined;
            const hlsUrl = this.streamingApi.getHlsUrl(
              this.mediaFileId,
              nativeStartQuality,
              startTime,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(hlsUrl, startTime, undefined, headers);
          }
        } else {
          await this.createShakaEngine();

          // Start subtitle loading in parallel with engine.load (Shaka doesn't need them upfront)
          subsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          if (mode === 'direct') {
            const streamUrl = this.streamingApi.getStreamUrl(
              this.mediaFileId,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(streamUrl, startTime, 'video/mp4');
          } else {
            const savedQualityId = this.activeQualityId();
            if (savedQualityId === 'auto') {
              this.qualityManager.selectQuality(
                { id: 'auto', label: 'Auto', height: 0 },
                this.engine, mode, true,
              );
            }

            // Resolve the target audio language BEFORE load so Shaka picks
            // the matching variant during manifest parse — otherwise
            // autoSelectAudioTrack would fire selectVariantTrack after load
            // and trigger a second init.mp4 + seg-0 fetch.
            const audioSettings = this.playerSettings.get();
            let preferredLang: string | undefined;
            if (audioSettings.rememberAudioSelections && this.mediaId) {
              preferredLang =
                this.playerSettings.getRememberedAudioTrack(this.mediaId) ?? undefined;
            }
            if (!preferredLang && !audioSettings.useDefaultAudioStream) {
              preferredLang = audioSettings.preferredAudioLanguage || undefined;
            }

            // Disable ABR when a specific quality is saved — avoids background
            // variant-switch chatter mid-playback. The backend serves a
            // single-variant master playlist in that case so there's only one
            // track anyway.
            this.engine!.configure({
              abr: {
                enabled: savedQualityId === 'auto',
                defaultBandwidthEstimate: 100_000_000,
              },
              streaming: {
                retryParameters: { timeout: 60_000, maxAttempts: 5, baseDelay: 1000 },
              },
              manifest: {
                retryParameters: { timeout: 30_000, maxAttempts: 5, baseDelay: 1000 },
              },
              ...(preferredLang ? { preferredAudioLanguage: preferredLang } : {}),
            });

            // Tell the backend the target quality so it pre-starts FFmpeg at
            // the right profile + applies the quality-change grace period to
            // protect the session from Shaka's startup bandwidth probe.
            const startQuality = savedQualityId !== 'auto' ? savedQualityId : undefined;
            const hlsUrl = this.streamingApi.getHlsUrl(
              this.mediaFileId,
              startQuality,
              startTime,
              this.playbackInfo?.sessionId,
            );
            await this.engine!.load(hlsUrl, startTime);
          }


        }
      }

      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, this.playbackMode());

      // Load tracks (skip subtitle loading if already preloaded for native engine)
      if (this.isOfflinePlayback) {
        // Offline: load pre-downloaded subtitles from local storage (no API)
        await this.loadOfflineSubtitles();
        this.loadAudioTracks();
      } else if (!this.availableSubtitles().length) {
        // subsPromise was started in parallel with engine.load (Shaka path)
        // For native path, subtitles are already preloaded above
        const subs = subsPromise
          ? await subsPromise
          : await this.trackManager.loadSubtitles(this.mediaId, this.mediaFileId, this.streamingApi, this.media);
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
        this.mediaId,
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
          // Extract profile name from active variant URL (e.g. "/720p/" → "720p")
          const active = this.getActiveVariant();
          const urlMatch = active?.originalVideoId?.match(/\/(\d+p)\//);
          const label = urlMatch?.[1]
            ?? this.qualityManager.resolutionLabel(variant.width, variant.height);
          this.qualityManager.activeResolution.set(label);
        }
        if (this.statsVisible()) {
          this.state.currentTime.set(this.engine?.currentTime ?? 0);
          this.statsRefreshTick.update((n) => n + 1);
        }
      }, 1000);
    } catch (e: any) {
      console.error('[Player] Init error:', e?.code, e?.category, e?.data, e);
      const msg = e?.message ?? String(e);
      this.state.error.set(msg);
      // TV / Tizen engine path: the AVPlay <object> + the hidden <video>
      // both stay parked on top of the error overlay if the engine dies
      // during load(). Force the player UI back into a visible-DOM state
      // so the user can read what blew up instead of staring at the
      // pre-paint bg-base-200 plane.
      if (this.isTizenEngine() && this.engine) {
        document.documentElement.classList.remove('native-player-active');
        const video = this.videoEl()?.nativeElement;
        if (video) video.style.display = '';
        try {
          await this.engine.destroy();
        } catch {
          /* AVPlay state may already be torn down — fine */
        }
        this.engine = null;
        this.isTizenEngine.set(false);
        this.isNativeEngine.set(false);
      }
      // Surface a toast on top of everything — fixed z-[9999], rendered
      // by the always-mounted <app-toast-container>, so it survives even
      // when the player-container itself isn't laying out correctly.
      try {
        this.toast.error(msg.slice(0, 240));
      } catch {
        /* toast service may not be ready during early init — ignore */
      }
    } finally {
      this.state.loading.set(false);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', this.onKeyDown);

    // Best-effort cleanup on page unload
    window.addEventListener('beforeunload', this.onBeforeUnload);

    // PiP mode change listener (native Android)
    if (this.isNative) {
      Pip.isAvailable().then(({ available }) => this.pipAvailable.set(available)).catch(() => this.pipAvailable.set(false));
      window.addEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.addEventListener('pipAction', this.onPipAction as EventListener);
      Pip.setAutoEnter({ enabled: true }).catch(() => {});
    }
    // Hardware back / gesture back: app.ts dispatches 'app:playerBack' when
    // the user is on /watch so it routes through the same onBack() as the
    // back arrow (replaceUrl to media detail rather than history.back).
    window.addEventListener('app:playerBack', this.onPlayerBackEvent);
  }

  ngOnDestroy() {
    this.savePosition();
    if (!this.castService.isConnected()) {
      this.stopStreamingSessions();
    }
    if (this.engine) {
      if (this.isNativeEngine()) {
        document.documentElement.classList.remove('native-player-active');
      }
      this.engine.destroy().catch(() => {});
    }
    this.removeSubtitleStyle();
    if (this.saveInterval) clearInterval(this.saveInterval);
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('app:playerBack', this.onPlayerBackEvent);
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

    // videoStarted is flipped on the engine 'firstFrame' event — emitted
    // once a frame has actually been presented to the compositor (Shaka:
    // requestVideoFrameCallback ; native: ExoPlayer onRenderedFirstFrame).
    // The DOM 'playing' event can precede first paint by a tick or two,
    // which would hide the fanart backdrop before the video shows.
    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
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

  private async createTizenEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    // Hide the HTML5 <video> — AVPlay paints to its own hardware surface.
    video.style.display = 'none';

    const engine = new TizenEngine();
    const container = this.containerEl()?.nativeElement ?? video.parentElement!;
    await engine.init(container);

    // Make the page transparent above the AVPlay surface — same trick as
    // the Capacitor native engine on Android. `html.native-player-active`
    // is the existing global hook the styles already key off.
    document.documentElement.classList.add('native-player-active');

    this.engine = engine;
    this.isTizenEngine.set(true);
    // Group with the native-engine UX (transparent overlay, controls hidden
    // on idle, no Shaka-specific buffering hooks). Without this flag, code
    // paths gated on `!isNativeEngine()` would treat AVPlay as a Shaka
    // session and (e.g.) try to attach <video> listeners we no longer own.
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });

    // Tizen audio-tracks listener is deliberately NOT wired. With MPEG-TS
    // HLS the variant has a single muxed audio, so AVPlay's
    // `getTotalTrackInfo()` only ever lists ONE entry — that would
    // shrink the picker to a single option after each reload, even
    // though the source has multiple languages. The shared streamInfo
    // fallback (`populateAudioTracksFromStreamInfo` → `si-*` ids) gives
    // us the full language list from the backend metadata, and the
    // reload path on switch (see `onSelectAudioTrack` Tizen branch)
    // applies the new track muxed-in via FFmpeg.
  }

  private async createNativeEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    video.style.display = 'none';

    const engine = new NativeEngine();
    const container = this.containerEl()?.nativeElement ?? video.parentElement!;
    await engine.init(container);

    // Force transparent background so native player shows through
    document.documentElement.classList.add('native-player-active');

    this.engine = engine;
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    // videoStarted flips on the engine 'firstFrame' event (forwarded from
    // ExoPlayer.Listener.onRenderedFirstFrame via the native plugin), so
    // the spinner+fanart stay until the surface is actually painting. No
    // separate stateChanged 'playing' hook needed — that fires on
    // STATE_READY which can precede the first frame on cold starts.
    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });

    // Listen for audio tracks from native engine.
    // ExoPlayer may emit this multiple times (e.g. rendition switch) —
    // never overwrite a good list with a smaller one. BUT: always let
    // engine-sourced tracks (audio-* / shaka-*) replace the streamInfo
    // fallback (si-*), even at equal length — their IDs enable client-side
    // PID switching instead of a full backend reload.
    engine.on('audioTracksChanged', (e) => {
      // Cross-reference engine tracks with streamInfo.audio so the dropdown
      // label matches what the media-detail header shows (e.g.
      // "Français (EAC3 - 5.1)" instead of Shaka's raw "fre" / "English (eng)").
      // Engine emits tracks in streamInfo order — see comment at the
      // streamInfo-fallback branch below.
      const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
      const audioList = (file?.streamInfo as any)?.audio ?? [];
      const tracks = e.tracks.map((t: any, i: number) => ({
        id: t.id,
        label: audioList[i] ? formatAudioLabel(audioList[i], this.translate, i + 1) : t.label,
        language: normalizeLang(t.language),
        selected: !!t.selected,
      }));
      const existing = this.availableAudioTracks();
      const newIsEngineSourced =
        tracks.length > 0 &&
        (tracks[0].id.startsWith('audio-') || tracks[0].id.startsWith('shaka-'));
      const existingIsFallback =
        existing.length > 0 && existing[0].id.startsWith('si-');
      // Upgrade ONLY when incoming has at least as many tracks as existing —
      // otherwise a transient partial emission (e.g. 1 audio track during
      // ExoPlayer's initial parse) would wipe the full 3-track si-* list.
      const upgradeFromFallback =
        newIsEngineSourced && existingIsFallback && tracks.length >= existing.length;
      if (tracks.length <= existing.length && !upgradeFromFallback) return;
      this.availableAudioTracks.set(tracks);
      // Use the track ExoPlayer reports as selected, fallback to first
      const selected = tracks.find((t: any) => t.selected) ?? tracks[0];
      this.activeAudioTrackId.set(selected.id);
      this.trackManager.autoSelectAudioTrack(
        tracks, this.mediaId, this.mediaFileId,
        this.activeAudioTrackId(),
        (trackId) => this.onSelectAudioTrack(trackId),
      );
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
    // Blur whatever was focused inside the controls so the next remote
    // Enter/OK doesn't accidentally activate an invisible button
    // (notably the back arrow at the top of the bar, which would quit
    // the player). The next D-pad / OK press will fall through to the
    // global key handler, show controls, and the user can navigate
    // them deliberately.
    if (typeof document !== 'undefined') {
      const active = document.activeElement as HTMLElement | null;
      if (active && active.closest('app-player-controls')) {
        active.blur();
      }
    }
  }

  private resetHideTimer() {
    if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
    if (this.seekDragging) return; // don't start hide timer during drag
    // 5 s on TV: focus is visual only, give the user time to read the labels.
    const delay = this.device.isTv() ? 5000 : 3000;
    this.controlsTimeout = setTimeout(() => {
      if (!this.paused() && !this.isDropdownOpen() && !this.seekDragging) this.controlsVisible.set(false);
    }, delay);
  }

  private isDropdownOpen(): boolean {
    // Check via signals (reliable on mobile)
    if (this.subtitlePickerOpen() || this.qualityPickerOpen()) return true;
    // Click-driven dropdowns / bottom sheets owned by <app-player-controls>.
    // Reported via (panelOpenChange) so we don't depend on DOM focus.
    if (this.controlsPanelOpen()) return true;
    // Check via DOM (DaisyUI dropdowns use focus-within)
    const container = this.containerEl()?.nativeElement;
    if (container?.querySelector('.dropdown:focus-within')) return true;
    const active = document.activeElement;
    return !!active && !!active.closest('.dropdown');
  }

  /**
   * Called by <app-player-controls> when its dropdown / bottom-sheet state
   * changes. While open, we keep the controls visible. On close, re-arm
   * the auto-hide so the bar fades back out in the normal delay.
   */
  onControlsPanelOpenChange(open: boolean): void {
    this.controlsPanelOpen.set(open);
    if (open) {
      if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
      this.controlsVisible.set(true);
    } else {
      this.resetHideTimer();
    }
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

  onSeekDragChange(dragging: boolean) {
    this.seekDragging = dragging;
    if (dragging) {
      // Cancel any pending hide
      if (this.controlsTimeout) clearTimeout(this.controlsTimeout);
      // Freeze the engine→state mirror while the user is dragging /
      // scrubbing the seekbar — otherwise the player's `timeUpdate`
      // stream keeps pushing the bar back to the live position under
      // the user's finger / arrow keys.
      this.state.seekLocked.set(true);
    } else {
      this.resetHideTimer();
      // Don't release the lock here: `onSeek` is about to fire with
      // the commit value and schedules its own release once the
      // engine catches up to the target.
    }
  }

  onSeek(time: number) {
    const t = Math.max(0, Math.min(time, this.duration() || 0));
    if (this.engine) {
      // Lock the mirror BEFORE issuing the seek so transient
      // `timeUpdate` events fired while the engine still reports the
      // OLD position can't bounce the seekbar back. The local
      // `state.currentTime.set(t)` pins the bar at the user's target
      // until `awaitSeekUnlock` lets the engine resume driving it.
      this.state.seekLocked.set(true);
      this.state.currentTime.set(t);
      void this.awaitSeekUnlock(t);
    }
    // Suppress auto-skip for 2s after a manual seek so the user can step back
    // into the intro on purpose without being kicked forward again.
    this.autoSkipSuppressedUntil = Date.now() + 2000;
    this.resetHideTimer();
  }

  /** Generation counter — every `onSeek` bumps it and the corresponding
   *  `awaitSeekUnlock` checks it before mutating state. Lets a newer
   *  seek invalidate an older one mid-flight (e.g. user holds an
   *  arrow key: each commit cancels the previous unlock loop). */
  private seekGeneration = 0;

  /** Await the engine's actual seek completion before lifting the
   *  state lock. Two phases:
   *    1. Wait for `engine.seek(target)`'s Promise — engines resolve
   *       this when their internal seek state machine has dispatched
   *       the request, which for HLS-fMP4 means the variant playlist
   *       has been re-parsed and the new segment buffer is being
   *       requested. Failure (Promise reject) keeps the lock on so
   *       the bar stays pinned at the user's target while the
   *       `engine.error` event surfaces a playback error UI.
   *    2. After the promise resolves, poll the engine's reported
   *       `currentTime` until it lands within 2s of the target. This
   *       catches engines (notably Shaka) that resolve their seek
   *       Promise as soon as the seek is queued, before the
   *       demuxer / decoder has actually moved.
   *
   *  Backward seeks that fall outside the cached segment range
   *  trigger a backend ffmpeg respawn (~10–20 s on long seeks); the
   *  30 s ceiling is sized for that. If convergence never happens we
   *  forcibly unlock so the user isn't stranded — the next live
   *  `timeUpdate` will take over the bar from the engine's actual
   *  position rather than the (now stale) target. */
  private async awaitSeekUnlock(target: number): Promise<void> {
    const gen = ++this.seekGeneration;
    try {
      await this.engine?.seek(target);
    } catch {
      // Engine rejected the seek (network error, codec stall, …).
      // Leave the lock on — the bar stays at the user's target and
      // the playback-error state surfaces via `state.error`.
      return;
    }
    if (gen !== this.seekGeneration) return;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      if (gen !== this.seekGeneration) return;
      const cur = this.engine?.currentTime ?? 0;
      if (Math.abs(cur - target) < 2) break;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (gen === this.seekGeneration) this.state.seekLocked.set(false);
  }

  // ── Skip-intro UX ──

  /** True when the cursor is inside the detected intro window. */
  readonly inIntroRange = computed(() => {
    const m = this.introMarker();
    if (!m) return false;
    const t = this.currentTime();
    return t >= m.startSeconds && t < m.endSeconds - 1;
  });

  /** Player-controls click handler — seek to the end of the intro. */
  skipIntro(): void {
    const m = this.introMarker();
    if (!m || !this.engine) return;
    this.engine.seek(m.endSeconds).catch(() => {});
    this.state.currentTime.set(m.endSeconds);
    this.resetHideTimer();
  }

  /**
   * Auto-skip when the cursor enters the intro window AND the user has the
   * setting on AND we haven't already auto-skipped this episode AND there
   * was no recent manual seek (2s cooldown).
   */
  private readonly autoSkipEffect = effect(() => {
    if (!this.inIntroRange()) return;
    if (!this.playerSettings.get().autoSkipIntro) return;
    if (Date.now() < this.autoSkipSuppressedUntil) return;
    const epId = this.episodeId ?? -1;
    if (this.autoSkipFiredForEpisode === epId) return;
    this.autoSkipFiredForEpisode = epId;
    this.skipIntro();
  });

  // ── Next-episode UX (outro) ──

  /**
   * Next episode to play for the current series — returned with its media
   * file so the "Épisode suivant" button can navigate directly. Returns null
   * for movies or when the series is on its last episode.
   */
  readonly nextEpisodeContext = computed<{
    episodeId: number;
    mediaFileId: number;
  } | null>(() => {
    this.mediaLoadedTick();
    const m = this.media;
    const currentEpId = this.episodeId;
    if (!m || m.type !== 'series' || !currentEpId || !m.seasons?.length) return null;
    // Flatten episodes in S/E order (skip specials: seasonNumber <= 0).
    const flat: { seasonNumber: number; episodeNumber: number; id: number }[] = [];
    for (const s of m.seasons) {
      if ((s.seasonNumber ?? 0) <= 0) continue;
      for (const ep of s.episodes ?? []) {
        flat.push({
          seasonNumber: s.seasonNumber,
          episodeNumber: ep.episodeNumber ?? 0,
          id: ep.id,
        });
      }
    }
    flat.sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    const idx = flat.findIndex((e) => e.id === currentEpId);
    if (idx < 0 || idx >= flat.length - 1) return null;
    const next = flat[idx + 1];
    const file = (m.files ?? []).find((f) => f.episodeId === next.id);
    if (!file) return null;
    return { episodeId: next.id, mediaFileId: file.id };
  });

  /** True when the cursor is inside the detected outro window. */
  readonly inOutroRange = computed(() => {
    const m = this.outroMarker();
    if (!m) return false;
    return this.currentTime() >= m.startSeconds;
  });

  /** Drives visibility of the floating "Épisode suivant" button. */
  readonly showNextEpisodeButton = computed(
    () => this.inOutroRange() && this.nextEpisodeContext() !== null,
  );

  /** Navigate to the next episode identified by {@link nextEpisodeContext}.
   *  Marks the current episode as watched (position := duration) before
   *  navigating. Detour through `/` forces Angular to remount this same
   *  route with fresh params (default router reuses the component and
   *  only snapshot-params are read once in ngAfterViewInit). */
  async goToNextEpisode(): Promise<void> {
    const next = this.nextEpisodeContext();
    if (!next || !this.mediaId) return;
    const mediaId = this.mediaId;

    // Force the current episode to be marked as completed server-side.
    // Backend threshold: position >= duration - 30s OR position >= duration * 0.9.
    const dur =
      (this.castService.isConnected()
        ? this.castService.duration()
        : this.engine?.duration) ||
      this.duration() ||
      0;
    if (dur > 0) {
      try {
        await this.streamingApi.updatePlaybackState(this.mediaId, {
          positionSeconds: dur,
          durationSeconds: dur,
          mediaFileId: this.mediaFileId,
          episodeId: this.episodeId,
        });
      } catch {
        /* non-blocking — navigate even if the update fails */
      }
    }

    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() =>
        // replaceUrl so the previous episode's /watch entry is overwritten
        // instead of stacked — otherwise closing the player leaves the old
        // episode in history and back reopens it.
        this.router.navigate(['/watch', next.mediaFileId], {
          queryParams: { mediaId, episodeId: next.episodeId },
          replaceUrl: true,
        }),
      );
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
    // iOS Safari rejects the standard Fullscreen API on arbitrary elements
    // (and `document.fullscreenEnabled` is false). The only path to a
    // fullscreen video there is the legacy `webkitEnterFullscreen` on the
    // <video> tag itself, which surfaces the native iOS player overlay.
    // Detect by capability, not UA, so iPadOS-as-desktop-mode still works.
    if (!document.fullscreenEnabled) {
      const video = this.videoEl()?.nativeElement as (HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitExitFullscreen?: () => void;
        webkitDisplayingFullscreen?: boolean;
      }) | undefined;
      if (video?.webkitEnterFullscreen) {
        if (video.webkitDisplayingFullscreen) {
          video.webkitExitFullscreen?.();
        } else {
          video.webkitEnterFullscreen();
        }
        return;
      }
    }
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
    // Re-derive the quality ladder from a fresh playback-info call made
    // with the Cast device profile, not the local player's pi. The
    // local pi was computed with the browser profile that accepts HEVC,
    // so its top rung is `'original'` (remux) at the source bitrate;
    // Cast can't direct-play HEVC and the cast ladder is a pure H.264
    // transcode set with the source-resolution rung at the profile
    // bitrate (e.g. 8 Mbps for 1080p). Reusing the browser pi here
    // makes `buildCastQualityOptions` drop the `'original'` entry and
    // present the wrong bitrates in the cast dropdown.
    const castProfile = this.castPlayerService.getCastDeviceProfile();
    const castPi = await this.streamingApi.getPlaybackInfo(
      this.mediaFileId,
      castProfile,
      this.activeBurnInId ?? undefined,
      this.activeAudioStreamIndex ?? undefined,
      undefined,
      position != null ? Math.floor(position) : undefined,
    );
    const castQualities = buildCastQualityOptions(
      castPi.qualities,
      this.castSettings.get().maxQuality,
    );
    // Snap the active pick onto the cast list when the local quality (e.g.
    // 'auto', 'original', '2160p' on a 1080p-capped cast profile) doesn't
    // exist there.
    const localActive = this.activeQualityId();
    const activeCastQualityId =
      castQualities.find(q => q.id === localActive)?.id
      ?? castQualities[0]?.id
      ?? '1080p';

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
      qualities: castQualities,
      audioTracks: this.castAudioOptions(),
      activeQualityId: activeCastQualityId,
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
        const savedQualityId = this.activeQualityId();
        const startQuality = mode !== 'direct' && savedQualityId !== 'auto'
          ? savedQualityId
          : undefined;
        const sid = this.playbackInfo?.sessionId;
        const url = mode === 'direct'
          ? this.streamingApi.getStreamUrl(this.mediaFileId, sid)
          : this.streamingApi.getHlsUrl(this.mediaFileId, startQuality, undefined, sid);
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
    // Explicit navigation rather than history.back() — nav-inside-player
    // (e.g. next-episode) leaves multiple /watch entries on the stack, and
    // router-reuse across same routes means history.back() only rewrites
    // the URL without exiting the player.
    // replaceUrl drops /watch from history so hardware/browser back does not
    // reopen the player on the way back.
    let target: string;
    if (!this.mediaId) {
      target = '/';
    } else {
      const kind = this.media?.type === 'series' ? 'series' : 'movies';
      target =
        this.episodeId && kind === 'series'
          ? `/series/${this.mediaId}/episode/${this.episodeId}`
          : `/${kind}/${this.mediaId}`;
    }
    // If the previous URL is already the target, just pop /watch off the
    // browser stack — replaceUrl would otherwise stack a duplicate
    // consecutive entry, forcing the user to click back twice on the detail
    // page (the first back lands on the duplicate, same URL → router-reuse,
    // no visible change).
    // Tell NavbarService to treat the upcoming NavigationEnd as a back-pop
    // so /watch is NOT pushed onto its in-app history stack. Without this,
    // pressing back on the destination detail page would pop /watch and
    // send the user straight back into the player.
    this.navbar.markAsBackNavigation();
    const prev = this.navHistory.previousUrl;
    if (prev && prev.split('?')[0] === target) {
      history.back();
      return;
    }
    if (target === '/') {
      void this.router.navigate(['/'], { replaceUrl: true });
      return;
    }
    void this.router.navigateByUrl(target, { replaceUrl: true });
  }

  onOpenMedia() {
    this.savePosition();
    const kind = this.media?.type === 'series' ? 'series' : 'movies';
    if (this.episodeId && kind === 'series') {
      this.router.navigate(
        ['/series', this.mediaId, 'episode', this.episodeId],
        { replaceUrl: true },
      );
    } else {
      this.router.navigate(['/' + kind, this.mediaId], { replaceUrl: true });
    }
  }

  // ── Offline subtitles ──

  /** Get subtitle configs from pre-downloaded local VTT files (for native ExoPlayer preload). */
  private async getOfflineSubtitleConfigs(): Promise<{ url: string; language: string; label: string }[]> {
    const task = this.dlCache.load().find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
    if (!task?.offlineSubtitles?.length) return [];
    const configs: { url: string; language: string; label: string }[] = [];
    for (const sub of task.offlineSubtitles) {
      // Native: file:// URI (ExoPlayer can read). Web: blob URL (Shaka).
      const localUrl = await this.offlineStorage.getSmallFileNativeUri(sub.key);
      if (localUrl) configs.push({ url: localUrl, language: sub.language, label: sub.label });
    }
    return configs;
  }

  /** Load offline subtitles into the subtitle picker (no API calls). */
  private async loadOfflineSubtitles() {
    const task = this.dlCache.load().find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
    if (!task?.offlineSubtitles?.length) return;
    const subs: { id: string; label: string; url: string; language: string; burnIn: false; forced: boolean }[] = [];
    for (const sub of task.offlineSubtitles) {
      // Native: file:// URI (must match preloaded URLs for track matching).
      // Web: blob URL (Shaka handles both).
      const localUrl = await this.offlineStorage.getSmallFileNativeUri(sub.key);
      if (localUrl) {
        subs.push({
          id: `offline-${sub.key}`,
          label: sub.label,
          url: localUrl,
          language: sub.language,
          burnIn: false,
          forced: sub.forced ?? false,
        });
      }
    }
    this.availableSubtitles.set(subs);
  }

  /**
   * Apply user's subtitle style settings to native engine. When the player
   * controls are visible, bumps the bottom margin by 5% so cues don't sit
   * under the controls bar — the WebKit `::cue` shift used in browser mode
   * doesn't apply on ExoPlayer/AVPlayer.
   */
  private applyNativeSubtitleStyle() {
    // Subtitle styling on engines that own their own renderer:
    // NativeEngine (ExoPlayer/AVPlayer) and TizenEngine (DOM overlay
    // via webapis.avplay) both expose `setSubtitleStyle`. Shaka has its
    // own CSS-variable path via `applySubtitleStyle()`. Duck-type the
    // method so we don't import TizenEngine here just for the type.
    if (!(this.engine && typeof (this.engine as NativeEngine).setSubtitleStyle === 'function')) {
      return;
    }
    const s = this.playerSettings.get();
    const extraMargin = this.controlsVisible() ? 10 : 0;
    (this.engine as NativeEngine).setSubtitleStyle({
      size: s.subtitleSize,
      color: s.subtitleColor,
      shadow: s.subtitleShadow,
      background: s.subtitleBackground,
      bottomMargin: s.subtitleBottomMargin + extraMargin,
    });
  }

  // ── Subtitles ──

  /** Load audio tracks (Shaka variant tracks or streamInfo fallback). */
  private loadAudioTracks() {
    if (!this.engine) return;

    // Wait a moment for the engine to parse the manifest/file
    setTimeout(() => {
      if (!this.engine) return;

      // Native engines populate audio tracks via audioTracksChanged event.
      // If already populated, don't overwrite.
      if (this.isNativeEngine() && this.availableAudioTracks().length > 1) return;

      const engineTracks = this.engine.getAudioTracks();

      if (engineTracks.length <= 1) {
        // Offline: don't show si-* fallback tracks — they can't be switched
        // via the engine. Only real engine-detected tracks are switchable.
        if (this.isOfflinePlayback) return;
        // Fallback: use streamInfo for online playback
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        const si = file?.streamInfo as any;
        const audioList = si?.audio;
        if (audioList?.length > 1) {
          const tracks = audioList.map((a: any, i: number) => ({
            id: `si-${i}`,
            label: formatAudioLabel(a, this.translate),
            language: normalizeLang(a.language),
          }));
          this.availableAudioTracks.set(tracks);
          // Set active to the track the backend is already using (preselected at startup)
          const activeIdx = this.activeAudioStreamIndex ?? 0;
          this.activeAudioTrackId.set(tracks[activeIdx]?.id ?? tracks[0].id);
          this.trackManager.autoSelectAudioTrack(
            tracks, this.mediaId, this.mediaFileId,
            this.activeAudioTrackId(),
            (trackId) => this.onSelectAudioTrack(trackId),
          );
        }
        return;
      }

      // Shaka's variant tracks expose `language` + `audioCodec` but not the
      // source-side title (English / Portuguese (Brazil) / …) — that lives in
      // streamInfo. With our HLS backend each EXT-X-MEDIA rendition is emitted
      // in streamInfo.audio order, so the i-th engine track maps to
      // streamInfo.audio[i]; use that to render the same label as the
      // streamInfo dropdown.
      const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
      const audioList = (file?.streamInfo as any)?.audio ?? [];
      const tracks = engineTracks.map((t, i) => ({
        id: t.id,
        label: audioList[i] ? formatAudioLabel(audioList[i], this.translate) : t.label,
        language: normalizeLang(t.language),
      }));

      this.availableAudioTracks.set(tracks);
      // Set active to the currently playing one
      const active = this.getActiveVariant();
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
    // 'si-*' and 'audio-*' suffixes are streamInfo audio indices: the
    // backend emits EXT-X-MEDIA renditions in streamInfo.audio order
    // and the native plugins enumerate them in that same order. Keep
    // activeAudioStreamIndex in sync so a later reloadStream() hands
    // the right index to /playback-info — otherwise the new master
    // marks the wrong rendition DEFAULT=YES and the player reverts
    // to the original language on the item swap. 'shaka-*' is
    // Shaka's internal audioId, not a streamInfo index.
    if (trackId.startsWith('si-') || trackId.startsWith('audio-')) {
      this.activeAudioStreamIndex = parseAudioIndex(trackId);
    }
    this.resetHideTimer();

    // Save selection
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId, this.mediaFileId,
    );

    const isEngineTrack =
      this.engine && (
        trackId.startsWith('shaka-') ||
        trackId.startsWith('audio-') ||
        trackId.startsWith('avplay-audio-')
      );

    // Engine-level audio switch (Shaka native or NativeEngine)
    if (isEngineTrack) {
      // Show spinner during audio switch (native player reloads the stream)
      if (this.isNativeEngine()) {
        this.state.buffering.set(true);
      }
      await this.engine!.selectAudioTrack(trackId);
      if (this.isNativeEngine()) {
        this.state.buffering.set(false);
      }
      return;
    }

    // si-* tracks are the streamInfo fallback. For HLS, the manifest always
    // exposes every audio rendition via EXT-X-MEDIA so Shaka switches
    // client-side — any transient si-* list upgrades to shaka-* as soon as
    // Shaka fires trackschanged, and the user picks the real track then.
    // For direct MP4 play, switching audio requires a backend reload with a
    // new audioStreamIndex. Offline: no backend.
    if (this.isOfflinePlayback) return;
    if (!trackId.startsWith('si-')) return;
    if (this.playbackMode() === 'direct') {
      await this.reloadStream();
    }
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    if (!this.engine) return;
    this.resetHideTimer();

    if (!sub) {
      try { this.engine.setTextVisibility(false); } catch {}
      this.activeSubtitleId.set(null);
      this.subtitlePickerOpen.set(false);
      localStorage.setItem('player.subtitleLang', '');
      this.trackManager.saveSubtitleSelection(this.mediaId, null);
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

    this.trackManager.saveSubtitleSelection(this.mediaId, sub.language, sub.forced, sub.id.startsWith('emb-'));
  }

  // ── Keyboard handler ──

  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    if (!this.engine) return;

    // When controls are hidden, the first remote press should only WAKE
    // them — never activate the invisible button that happens to be
    // focused. Without this, Enter/OK on TV silently triggers the back
    // arrow (the first focusable inside the controls bar) and quits
    // the player. We swallow the event after `showControls` so the
    // default activation path doesn't fire.
    // EXCLUSION: the Tizen Return key (keyCode 10009 / `XF86Back`) must
    // bubble up to the window-level handler in `app.ts` — otherwise the
    // user can't exit the player. Same for `Escape` on dev keyboards.
    const isBackKey = e.keyCode === 10009 || e.key === 'XF86Back' || e.key === 'GoBack' || e.key === 'Escape';
    if (!isBackKey && !this.controlsVisible() && this.device.isTv()) {
      this.showControls();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // ArrowLeft/Right are claimed by the seekbar when it owns focus, and used
    // for D-pad navigation between controls otherwise. Skip them here unless
    // no control has focus (in which case keep the legacy "background" seek).
    const active = document.activeElement as HTMLElement | null;
    const arrowSeekAllowed = !active || active === document.body;

    switch (e.key) {
      case ' ':
      case 'k':
        // Space is the universal activation key on buttons / links. When
        // the controls bar is shown and focus sits on an interactive
        // element inside it, let the native activation fire instead of
        // hijacking the press for play/pause. 'k' has no such overload —
        // it always toggles playback.
        if (
          e.key === ' ' &&
          this.controlsVisible() &&
          active &&
          active !== document.body &&
          active.closest('app-player-controls')
        ) {
          return; // fall through to native activation
        }
        e.preventDefault();
        this.onTogglePlay();
        break;
      case 'ArrowLeft':
        if (!arrowSeekAllowed) break;
        e.preventDefault();
        this.onSeek(this.engine.currentTime - 10);
        break;
      case 'ArrowRight':
        if (!arrowSeekAllowed) break;
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
        if (this.controlsVisible()) {
          this.hideControls();
          return; // skip the trailing showControls() — we want them hidden
        }
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
    // Don't wake controls for the back key — the user wants to LEAVE.
    // `app.ts` listens on `window` and dispatches `app:playerBack`,
    // which (with no controls shown) goes straight to `onBack()`.
    // Without this guard, the trailing `showControls()` fired first,
    // `onPlayerBackEvent` then saw controls visible and only hid them
    // — so Return-on-TV looked stuck.
    if (!isBackKey) this.showControls();
  };

  // ── Event handlers ──

  private onBeforeUnload = () => {
    this.fireAndForgetStopSessions();
  };

  private onPlayerBackEvent = () => {
    // TV: D-pad navigation needs an explicit "dismiss controls" step
    // before exiting the player, so back/Return on the remote first
    // closes the controls bar, then leaves on the second press.
    // Phones and tablets get the direct exit — touch users dismiss
    // controls by tapping the video surface, not via hardware back.
    if (this.device.isTv() && this.controlsVisible()) {
      this.hideControls();
      return;
    }
    this.onBack();
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
    // iOS WKWebView sometimes doesn't reflow fixed-position elements after
    // rotation, leaving the player UI oversized. Force a layout recalc.
    window.scrollTo(0, 0);
    document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
    // Native subtitle bottom margin is a % of video height — reapply after
    // orientation change so the value is recalculated against the new dimensions.
    if (this.isNativeEngine() && this.engine) {
      this.applyNativeSubtitleStyle();
    }
  };

  onCloseStats() {
    this.statsVisible.set(false);
  }

  async onSelectQualityById(id: string) {
    const option = this.availableQualities().find(q => q.id === id);
    if (!option) return;
    const mode = this.playbackMode();
    // User picked this explicitly → persist at app level.
    this.qualityManager.selectQuality(option, this.engine, mode, false, true);

    // Transcode mode: the backend emits a single-variant master playlist
    // (the one matching savedQualityId), so switching quality requires a
    // full stream reload — same trade-off the native path already makes.
    // The reload is done so that Shaka can't probe lower variants during
    // startup (which would spin up FFmpeg at the wrong quality).
    if (mode !== 'direct') {
      await this.reloadStream();
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

    // Remember active subtitle so we can restore it after reload
    const activeSub = this.activeSubtitleId()
      ? this.availableSubtitles().find(s => s.id === this.activeSubtitleId())
      : null;

    // Native: stop the player before reload to avoid freeze
    if (this.isNativeEngine()) {
      await NativePlayer.stop().catch(() => {});
    }

    // Stop only this device's session — multi-device viewers on the
    // same file with a different profile should stay alive.
    await this.streamingApi
      .stopSessions(this.mediaFileId, this.playbackInfo?.sessionId)
      .catch(() => {});

    const deviceProfile = this.deviceProfileService.getProfile();
    this.playbackInfo = await this.streamingApi.getPlaybackInfo(
      this.mediaFileId, deviceProfile, this.activeBurnInId ?? undefined, this.activeAudioStreamIndex,
    );
    const pi = this.playbackInfo;
    this.introMarker.set(pi.markers?.intro ?? null);

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
      await this.engine.load(
        this.streamingApi.getStreamUrl(this.mediaFileId, this.playbackInfo?.sessionId),
        currentPos,
        'video/mp4',
      );
    } else {
      const savedQualityId = this.activeQualityId();
      const startQuality = savedQualityId !== 'auto' ? savedQualityId : undefined;
      await this.engine.load(
        this.streamingApi.getHlsUrl(
          this.mediaFileId,
          startQuality,
          currentPos,
          pi.sessionId,
        ),
        currentPos,
      );
    }

    this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, mode);
    this.engine.play().catch(() => {});

    // Restore active subtitle (non burn-in) after Shaka reload
    if (activeSub && !activeSub.burnIn && activeSub.url) {
      try {
        const track = await this.engine.addTextTrack(activeSub.url, activeSub.language, activeSub.label);
        this.engine.selectTextTrack(track);
        this.engine.setTextVisibility(true);
      } catch {}
    }
  }

  private fireAndForgetStopSessions() {
    if (!this.mediaFileId || this.playbackMode() === 'direct') return;
    const url = this.streamingApi.getStopSessionsUrl(
      this.mediaFileId,
      this.activeSessionId(),
    );
    fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  /** Find a variant track matching a quality id (e.g. '480p', 'original') by URL or height fallback. */
  private findVariantByQualityId(qualityId: string, targetHeight: number): any | null {
    if (!this.engine) return null;
    const tracks = this.engine.getVariantTracks();
    if (!tracks.length) return null;
    return findVariantByProfileName(tracks, qualityId)
      ?? findBestVariantForHeight(tracks, targetHeight);
  }

  /** Get the currently active variant track. */
  private getActiveVariant(): any | null {
    return this.engine?.getVariantTracks()?.find((t: any) => t.active) ?? null;
  }

  private stopStreamingSessions() {
    if (!this.mediaFileId || this.playbackMode() === 'direct') return;
    this.streamingApi
      .stopSessions(this.mediaFileId, this.activeSessionId())
      .catch(() => {});
  }

  /** Wall-clock timestamp (ms) of the last PUT to /state. Used to dedup
   *  the cluster of saves that fire on exit (onBack, ngOnDestroy, the
   *  savePosition interval and the 'seeked' event all hit savePosition
   *  within the same tick). Time-based instead of position-based so a
   *  paused player still emits a heartbeat every 10 s — the backend's
   *  {@link LiveSessionRegistry} relies on it to keep the session warm. */
  private lastSaveAt = 0;

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

    const now = Date.now();
    if (now - this.lastSaveAt < 2_000) return;
    this.lastSaveAt = now;

    const payload: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
      sessionId?: string;
      state?: 'playing' | 'paused' | 'buffering';
      quality?: string | null;
    } = {
      positionSeconds: pos,
      durationSeconds: dur || 0,
      mediaFileId: this.mediaFileId,
      episodeId: this.episodeId,
    };

    const sessionId = this.activeSessionId();
    if (sessionId) {
      payload.sessionId = sessionId;
      payload.state = this.paused() ? 'paused' : 'playing';
      payload.quality = this.activeQualityId() ?? null;
    }

    // Offline queue persists position only — the heartbeat-related
    // fields (sessionId / state / quality) are pointless once the
    // backend session has already expired by the time we reconnect.
    const offlinePayload = {
      mediaId: this.mediaId,
      mediaFileId: this.mediaFileId,
      episodeId: this.episodeId,
      positionSeconds: payload.positionSeconds,
      durationSeconds: payload.durationSeconds,
    };
    if (this.network.isOnline()) {
      try {
        await this.streamingApi.updatePlaybackState(this.mediaId, payload);
      } catch {
        this.offlineSync.queue(offlinePayload);
      }
    } else {
      this.offlineSync.queue(offlinePayload);
    }
  }

  /** Push subtitle appearance to both rendering paths:
      - UITextDisplayer (DOM): CSS variables on .player-container, consumed
        by the .shaka-text-wrapper / .shaka-text-container rules in
        styles.css.
      - NativeTextDisplayer (fallback / WebKit fullscreen): a global
        <style> that targets video::cue. */
  private applySubtitleStyle() {
    const s = this.playerSettings.get();
    const fontSize = SUBTITLE_SIZE_MAP[s.subtitleSize] ?? '0.7em';
    const color = SUBTITLE_COLOR_MAP[s.subtitleColor] ?? '#ffffff';
    const shadow = SUBTITLE_SHADOW_MAP[s.subtitleShadow] ?? 'none';
    const bg = SUBTITLE_BG_MAP[s.subtitleBackground] ?? 'transparent';

    // CSS variables for UITextDisplayer path + the WebKit cue-display
    // bottom-margin lift (set on the player container so the variable
    // reaches both the <video> shadow pseudo and the .shaka-text-container
    // sibling).
    const container = this.containerEl()?.nativeElement;
    if (container) {
      container.style.setProperty('--cue-font-size', fontSize);
      container.style.setProperty('--cue-color', color);
      container.style.setProperty('--cue-bg', bg);
      container.style.setProperty('--cue-shadow', shadow);
      container.style.setProperty('--cue-bottom-margin', `${s.subtitleBottomMargin}vh`);
    }
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.style.setProperty('--cue-bottom-margin', `${s.subtitleBottomMargin}vh`);
    }

    // Native VTTCue path: keep the global <style> as a fallback for cases
    // where Shaka falls back to NativeTextDisplayer (e.g. WebKit
    // fullscreen) and for non-Shaka native engines.
    const css = `video::cue {
  font-size: ${fontSize} !important;
  color: ${color} !important;
  background: ${bg} !important;
  background-color: ${bg} !important;
  text-shadow: ${shadow};
  line-height: 1.2 !important;
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
