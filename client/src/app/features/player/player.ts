import {
  AfterViewInit,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { StreamingApiService, PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService, DeviceProfile } from '../../core/services/browser-device-profile.service';
import type { PreRollItem } from '@fliks/plugin-ui';
import { SseService, RemoteQualityRung } from '../../core/services/sse.service';
import { RemoteService } from '../../core/services/remote.service';
import { backTarget } from './back-target';
import { PlaybackSession } from '../../core/services/playback/playback-session';
import { LocalPlaybackOutput } from './local-playback-output';
import type { CastStart, LocalHandoff, PlaybackOutput, PlaybackSnapshot } from '../../core/services/playback/playback-output';
import { PickerRow } from '../../shared/remote-picker/remote-picker-list';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { AutoDownloadService } from '../../core/services/auto-download.service';
import { NetworkService } from '../../core/services/network.service';
import { DownloadCacheService, type DownloadTask, type OfflineSubtitle } from '../../core/services/download-cache.service';
import {
  CastPlayerService,
  CastAudioOption,
  buildCastAudioOptions,
} from '../../core/services/cast-player.service';
import { ServerConfigService } from '../../core/services/server-config.service';
import { NavigationHistoryService } from '../../core/services/navigation-history.service';
import { ToastService } from '../../core/services/toast.service';
import { NavbarService } from '../../core/services/navbar.service';
import { PlaybackQueueService } from '../../core/services/playback-queue.service';
import { buildPlayerStats, formatAudioLabel, formatAudioParts, playbackModeOf, readyDownloadFor, SpriteMetadata, widthForProfile, type CropRect, type OfflineCrop, type PlaybackMode } from '../../core/utils/player.utils';
import { formatErrorDiagnostics, type PlaybackError } from '../../core/services/playback-engine/playback-error';
import { environment } from '../../../environments/environment';
import { normalizeLangCode } from '../../core/utils/language.utils';
import {
  PlayerSettingsService,
  SUBTITLE_SIZE_MAP, SUBTITLE_COLOR_MAP, SUBTITLE_SHADOW_MAP, SUBTITLE_BG_MAP,
  type AudioStreamChoice,
} from '../../core/services/player-settings.service';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';

import type { AudioTrack, PlaybackEngine, QoeSample, VariantTrack } from '../../core/services/playback-engine/playback-engine';
import { QoeReporter } from '../../core/services/qoe-reporter.service';
import { PlayerQoe, PlayheadWatch, frozenAfterMs, type ReloadWhy } from './player-qoe';
import {
  createEngineSurface,
  releaseEngineSurface,
  type EngineSurfaceKind,
} from '../../core/services/playback-engine/engine-surface';
import { NativeEngine } from '../../core/services/playback-engine/native-engine';
import { DesktopEngine } from '../../core/services/playback-engine/desktop-engine';
import { TizenEngine, isTizenAvplayAvailable } from '../../core/services/playback-engine/tizen-engine';
import { NativePlayer, type NativeSidecarSubtitle } from '../../core/plugins/native-player.plugin';
import { PlayerScreen } from './player-screen';
import { imageUrlWithSize } from '../../core/pipes/resolve-url.pipe';
import { PlayerStateService } from '../../core/services/player-state.service';
import { subtitleManifestRank } from '../../core/utils/subtitle-tracks';
import { TrackManagerService, SubtitleOption, type LaunchTracks, launchPickFor, streamIndexForTrack, trackForStreamIndex } from '../../core/services/track-manager.service';
import { BEST_QUALITY_ID, QualityManagerService } from '../../core/services/quality-manager.service';
import { DeviceService, viewTransitionsEnabled } from '../../core/services/device.service';

/** An audio entry of the menu: an engine track (or a streamInfo fallback) labelled from streamInfo. */
interface AudioOption {
  id: string;
  label: string;
  language: string;
  menuHead?: string;
  menuSub?: string;
  /** False when the device cannot decode the track: listed, but never picked. */
  supported?: boolean;
}

/** Long enough to fold a start-up burst into one report, short enough that a
 *  controller still sees the change in about a frame's time. */
const FORCED_SAVE_COALESCE_MS = 300;
const HEARTBEAT_MS = 10_000;


interface PipPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  enter(): Promise<void>;
  setAutoEnter(options: { enabled: boolean }): Promise<void>;
  updatePlaybackState(options: { playing: boolean }): Promise<void>;
}
const Pip = registerPlugin<PipPlugin>('Pip');

import { LucideAirplay, LucideCast, LucideInfo, LucideVolumeX, LucideX } from '@lucide/angular';
import { AirPlayService } from '../../core/services/airplay.service';
import { PlayerControlsComponent } from './controls/player-controls';
import { PlayerErrorOverlayComponent } from './overlay/player-error-overlay';
import { ControlsVisibilityService } from './controls/controls-visibility';
import { type ControlsModel, outputModel } from './controls/controls-model';
import { NO_NOW_PLAYING, NowPlayingMetadataService, describeNowPlaying, mediaSessionText, type NowPlayingMetadata } from '../../core/services/playback/now-playing-metadata.service';
import { CopyFallbackController } from './copy-fallback-controller';
import { RecoveryController } from './recovery-controller';
import { WebVideoCropController } from './web-video-crop-controller';
import { EdlController } from './edl-controller';
import { CueController } from './cue-controller';
import { QueueController } from './queue-controller';
import { RemoteController } from './remote-controller';
import { PartySync } from '../../core/services/party/party-sync';
import { KeyboardOverlayService } from '../../core/services/keyboard-overlay.service';
import { PartyService } from '../../core/services/party/party.service';
import { ReactionsService } from '../../core/services/party/reactions.service';
import { PartyPanelComponent } from './party/party-panel';
import { PartyFloatersComponent } from './party/party-floaters';
import { PartyReactionDockComponent } from './party/party-reaction-dock';
import { PartyReactionSettingsComponent } from './party/party-reaction-settings';
import { PartySettingsComponent } from './party/party-settings';
import { KeyboardController } from './keyboard-controller';
import { SubtitleController } from './subtitle-controller';
import { isMutedAt, muteRangesOf } from '../../core/utils/edl-policy';
import { PlayerStatsOverlayComponent, PlayerStats } from './overlay/player-stats-overlay';
import { SubtitleSyncPanelComponent } from './overlay/subtitle-sync-panel/subtitle-sync-panel';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';

@Component({
  imports: [TranslatePipe, LucideAirplay, LucideCast, LucideInfo, LucideVolumeX, LucideX, PlayerControlsComponent, PlayerStatsOverlayComponent, SubtitleSyncPanelComponent, PlayerErrorOverlayComponent, DefaultFocusDirective, PartyPanelComponent, PartyFloatersComponent, PartyReactionDockComponent, PartyReactionSettingsComponent, PartySettingsComponent],
  templateUrl: './player.html',
  host: { '(document:fullscreenchange)': 'onFullscreenChange()' },
  providers: [ControlsVisibilityService, CopyFallbackController, WebVideoCropController, QueueController, RemoteController, SubtitleController],
  encapsulation: ViewEncapsulation.None,
  styles: [`
    .player-container {
      position: fixed;
      /* 100dvh caps the container to the visible viewport above iOS Safari's bottom URL bar; 100vh is the
         fallback for browsers without dvh (Tizen Chrome 85). */
      inset: 0;
      height: 100vh;
      height: 100dvh;
      /* The bottom inset the controls clear; none once the container no longer reaches the screen's bottom. */
      --safe-bottom: env(safe-area-inset-bottom, 0px);
      background-color: #000;
      z-index: 100;
      overflow: hidden;
      -webkit-user-select: none;
      user-select: none;
      /* iOS WKWebView rotation fix: force GPU compositing so WebKit
         recalculates the fixed position after orientation change. */
      -webkit-transform: translateZ(0);
      animation: player-open 260ms cubic-bezier(0.2, 0, 0, 1);
    }
    /* translateZ(0) is repeated in the keyframes so the iOS compositing hint
       above survives the animation, which would otherwise replace transform. */
    @keyframes player-open {
      from {
        opacity: 0;
        transform: translateZ(0) scale(0.8);
      }
      to {
        opacity: 1;
        transform: translateZ(0) scale(1);
      }
    }
    /* Closing where view transitions are unavailable (native, TV): the player
       shrinks over the shell, since the destination page is not painted yet. */
    .player-container.closing {
      animation: player-close 200ms cubic-bezier(0.4, 0, 1, 1) both;
    }
    @keyframes player-close {
      to {
        opacity: 0;
        transform: translateZ(0) scale(0.8);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .player-container {
        animation-name: player-open-fade;
      }
      @keyframes player-open-fade {
        from {
          opacity: 0;
        }
      }
      .player-container.closing {
        animation-name: player-close-fade;
      }
      @keyframes player-close-fade {
        to {
          opacity: 0;
        }
      }
    }
    .party-shell {
      position: fixed;
      inset: 0;
      z-index: 100;
      -webkit-transform: translateZ(0);
    }
    @media (prefers-reduced-motion: no-preference) {
      .party-shell.in-party > .player-container {
        transition:
          right 250ms cubic-bezier(0.2, 0, 0, 1),
          height 250ms cubic-bezier(0.2, 0, 0, 1);
      }
    }
    .party-shell[data-party-dock='right'] > .player-container {
      right: 360px;
    }
    /* Beside the side panel there is room above the keyboard: the player fits there while typing. */
    .party-shell.keyboard-open[data-party-dock='right'] > .player-container {
      height: calc(100vh - var(--keyboard-h));
      height: calc(100dvh - var(--keyboard-h));
      --safe-bottom: 0px;
    }
    .party-shell[data-party-dock='drawer'] > .player-container {
      right: 40%;
    }
    .party-shell[data-party-dock='tv'] > .player-container {
      right: 30%;
    }
    .party-shell[data-party-dock='bottom'] > .player-container {
      bottom: auto;
      height: 56.25vw;
    }
    .player-container.native-player > .player-video {
      display: none !important;
    }
    .player-video {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: contain;
      /* Override Tailwind preflight's max-width/height:auto, which leaves black bars on all four sides instead
         of letterboxing the short axis. */
      max-width: none !important;
      max-height: none !important;
    }
    /* Lift native subtitles by --cue-bottom-margin, more when controls show; toggled on the <video> itself
       because an ancestor toggle may not restyle the UA-shadow pseudo in Chromium. */
    .player-video::-webkit-media-text-track-display {
      transition: transform 200ms ease;
      transform: translateY(calc(-1 * var(--cue-bottom-margin, 0vh)));
    }
    .player-video.controls-visible::-webkit-media-text-track-display {
      transform: translateY(calc(-1 * var(--cue-bottom-margin, 0vh) - 20vh));
    }
  `],
})
export class PlayerComponent implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly qoe = new PlayerQoe(inject(QoeReporter));
  private readonly offlineStorage = inject(OfflineStorageService);
  private readonly offlineSync = inject(OfflinePlaybackSyncService);
  private readonly autoDownload = inject(AutoDownloadService);
  private readonly network = inject(NetworkService);
  private readonly dlCache = inject(DownloadCacheService);
  private readonly mediaService = inject(MediaService);
  private readonly deviceProfileService = inject(BrowserDeviceProfileService);
  private readonly sseService = inject(SseService);
  readonly remoteService = inject(RemoteService);
  private readonly authService = inject(AuthService);
  readonly castService = inject(CastService);
  readonly airPlay = inject(AirPlayService);
  private detachAirPlay: () => void = () => {};
  private readonly castPlayerService = inject(CastPlayerService);
  protected readonly session = inject(PlaybackSession);
  private readonly pipWired = signal(false);
  /** Leaving the app auto-enters PiP only while the picture is local: a cast has nothing to shrink. */
  private readonly pipAutoEffect = effect(() => {
    if (this.pipWired()) Pip.setAutoEnter({ enabled: this.session.isLocal() }).catch(() => {});
  });
  private readonly serverConfig = inject(ServerConfigService);
  private readonly playerSettings = inject(PlayerSettingsService);
  private readonly navHistory = inject(NavigationHistoryService);
  private readonly toast = inject(ToastService);
  private readonly navbar = inject(NavbarService);
  private readonly queue = inject(PlaybackQueueService);
  private readonly translate = inject(TranslateService);
  private readonly title = inject(Title);

  /** The OS media session (browser, MPRIS, SMTC, Now Playing) follows the item this route plays. */
  private readonly mediaSessionEffect = effect(() => {
    const meta = this.nowPlaying();
    if (!meta.title) return;
    untracked(() => {
      const { title, artist } = mediaSessionText(meta);
      const artwork: MediaImage[] = [];
      if (meta.posterUrl) artwork.push({ src: this.serverConfig.resolveUrl(meta.posterUrl), sizes: '300x450', type: 'image/jpeg' });
      if (meta.fanartUrl) artwork.push({ src: this.serverConfig.resolveUrl(meta.fanartUrl), sizes: '1280x720', type: 'image/jpeg' });
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title, artist, artwork });
      void window.fliksDesktop?.setMediaSession({ title, artist, artworkUrl: artwork[0]?.src });
    });
  });

  /** Set the tab title from the loaded media (the player route is outside the layout's title effect); keeps the
   *  previous title until the name resolves so the tab doesn't flicker. */
  private readonly tabTitleEffect = effect(() => {
    const media = this.mediaTitle();
    const episode = this.episodeTitle();
    const main = episode ? (media ? `${media} - ${episode}` : episode) : media;
    if (!main) return;
    this.title.setTitle(`${main} · ${this.translate.instant('app.name')}`);
  });

  // New extracted services
  private readonly state = inject(PlayerStateService);
  private readonly trackManager = inject(TrackManagerService);
  private readonly qualityManager = inject(QualityManagerService);
  readonly device = inject(DeviceService);

  /** Reset the singleton state at field-init: effects below run before ngAfterViewInit's reset. */
  private readonly _stateReset = (this.state.reset(), null);

  /** One-shot DV-passthrough probe, read at error time; a per-load `reset()` must not clear it. */
  private readonly _dvProbe = (
    this.state.setDolbyVisionProbe(() => this.isDolbyVisionPassthrough()),
    null
  );

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');
  private readonly controls = viewChild(PlayerControlsComponent);
  private readonly shellEl = viewChild<ElementRef<HTMLDivElement>>('partyShell');

  /** Active engine (Shaka on web, Native on Android/iOS); Cast is driven by castPlayerService + castService. */
  private engine: PlaybackEngine | null = null;
  readonly isNativeEngine = signal(false);
  /** AVPlay (Samsung TV HW decoder) is driving playback: same UX as a Capacitor native engine. */
  readonly isTizenEngine = signal(false);
  /** Tizen WebApp with AVPlay available; distinct from `isNative` (Capacitor) and `device.isTv()` (any TV form
   *  factor, including the browser preview). */
  readonly isTizen = isTizenAvplayAvailable();
  /** LG webOS uses a regular `<video>`, so it groups with the Shaka UX, not the transparent-plane native one. */
  readonly isWebOs = this.device.tvPlatform() === 'webos';
  /** Electron shell with embedded mpv: same transparent-overlay UX as the Capacitor native engine. */
  readonly isDesktopNative = this.device.desktopPlatform() === 'electron';
  /** The page or, on desktop, the native compositor window is fullscreen. */
  readonly fullscreen = signal(false);

  /** Template binding — true when using native (ExoPlayer/AVPlayer) engine. */
  get nativeEngine(): boolean {
    return this.isNativeEngine();
  }

  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private appPauseListener: PluginListenerHandle | null = null;
  /** {@link completePostLoadSetup} runs once per mount, from the first load or its copy fallback. */
  private firstLoadSetupDone = false;
  /** True while the user is actively dragging / scrubbing the seekbar. */
  private readonly seekDragging = signal(false);
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private playheadInterval: ReturnType<typeof setInterval> | null = null;
  private subtitleStyleEl: HTMLStyleElement | null = null;
  // A backward seek can trigger a 10-30s backend respawn (awaitSeekUnlock's
  // ceiling) with a frozen-but-healthy playhead; widen the window right after.
  private lastSeekAt = 0;
  private lastQualitySwitchAt = 0;
  /** Buffering right after a reload or track switch finishes is that switch settling, not a stall. */
  private qoeGraceUntil = 0;
  // Desktop mpv far-seek thresholds: forward slack above its cache end, and the back-cache window still served;
  // seeks outside the band reload at the offset.
  private readonly desktopSeekCacheSlackS = 1;
  private readonly desktopSeekBackWindowS = 15;
  // ── Template-facing signal aliases (delegate to services) ──
  readonly loading = this.state.loading;
  readonly videoStarted = this.state.videoStarted;
  readonly error = this.state.error;
  readonly paused = this.state.paused;
  readonly uiPaused = this.state.uiPaused;
  readonly autoplayBlocked = this.state.autoplayBlocked;
  readonly currentTime = this.state.currentTime;
  readonly duration = this.state.duration;
  readonly volume = this.state.volume;
  readonly muted = this.state.muted;
  readonly buffering = this.state.buffering;
  readonly bufferedEnd = this.state.bufferedEnd;
  /** Spinner stands in for the video until first paint, except on a refused autoplay (ready, paused: show
   *  play). */
  readonly spinnerVisible = computed(
    () =>
      !this.autoplayBlocked() &&
      !this.error() &&
      (this.loading() ||
        this.buffering() ||
        // Shaka can hold a starved playhead without ever reporting `buffering`.
        this.frozenSince() > 0 ||
        !this.videoStarted()),
  );
  /** Everything the controls read of the playing output: the cast or remote output, else the engine's own signals. */
  protected readonly view = computed<ControlsModel>(() => {
    const o = this.session.isLocal() ? null : this.session.output();
    if (o) return outputModel(o, this.session.nowPlaying());
    return {
      paused: this.uiPaused(),
      spinner: this.spinnerVisible(),
      videoStarted: this.videoStarted(),
      currentTime: this.currentTime(),
      duration: this.duration(),
      volume: this.volume(),
      muted: this.muted(),
      canSetVolume: true,
      mediaTitle: this.mediaTitle(),
      episodeTitle: this.displayEpisodeTitle(),
      logoUrl: this.nowPlaying().logoUrl,
      hasNext: this.localOutput.canPlayNext(),
      subtitles: this.subs.availableSubtitles(),
      audioTracks: this.availableAudioTracks(),
      qualities: this.availableQualities(),
      activeSubtitleId: this.subs.activeSubtitleId(),
      activeAudioTrackId: this.activeAudioTrackId(),
      activeQualityId: this.activeQualityId(),
      activeQualityLabel: this.activeQualityLabel(),
      spriteUrl: this.spriteUrl(),
      spriteMetadata: this.spriteMetadata(),
      skipCueLabelKey: this.localOutput.skipCue()?.labelKey ?? null,
      timeline: this.localOutput.timeline(),
      nextCue: false,
    };
  });
  readonly playbackMode = this.state.playbackMode;
  readonly hwAccel = this.state.hwAccel;
  readonly activeQualityId = this.qualityManager.activeQualityId;
  readonly availableQualities = this.qualityManager.availableQualities;
  readonly activeResolution = this.qualityManager.activeResolution;
  /** Label of the picked quality, matching the dropdown's `q.label` (never ids like `1080p-hdr`); id until
   *  loaded. */
  readonly activeQualityLabel = computed(() => {
    const id = this.activeQualityId();
    if (id === 'auto') {
      const res = this.activeResolution();
      return res
        ? this.translate.instant('player.auto_resolution', { res })
        : this.translate.instant('player.auto');
    }
    return this.availableQualities().find((q) => q.id === id)?.label ?? id;
  });

  // Component-owned signals (not delegated)
  readonly playbackRate = signal(1);
  readonly chrome = inject(ControlsVisibilityService);
  /** A seek still in flight pins the bar too: one slower than the hide delay
   *  would otherwise retract it before the playhead landed. */
  private readonly _chromePins = (this.chrome.configure({
    pinned: computed(
      () => this.uiPaused() || this.buffering() || this.seekDragging() || this.state.seekLocked() || !this.session.isLocal(),
    ),
  }), null);
  private readonly copyFallback = inject(CopyFallbackController);
  private readonly _copyFallbackAttach = (this.copyFallback.attach(this), null);
  protected readonly recovery = new RecoveryController({
    engine: () => this.engine,
    isDestroyed: () => this.destroyed,
    isCasting: () => !this.session.isLocal(),
    isOnline: () => this.network.isOnline(),
    hasMedia: () => !!this.mediaFileId,
    isPaused: () => this.paused(),
    isLoading: () => this.state.loading(),
    fatalNoRetry: () => this.state.fatalNoRetry(),
    reloadInFlight: () => this.reloadingStream,
    lastSeekAt: () => this.lastSeekAt,
    resumePosition: () => {
      // engine.currentTime can read 0 right after an error (e.g. Tizen AVPlay): use the mirrored position.
      const pos = this.engine?.currentTime ?? 0;
      return pos > 1 ? pos : this.state.currentTime();
    },
    setRecovering: (on) => this.state.setRecovering(on),
    hasError: () => !!this.state.error(),
    failWith: (e, opts) => this.state.failWith(e, opts),
    reloadSession: (pos) => this.refreshSidAndReload(pos, { preservePause: true, unmute: false }),
    warmSession: async () => {
      await this.authService.ensureStreamToken(this.mediaFileId);
      await this.prewarmCurrentStream();
    },
    beat: () => this.savePosition(),
    dropStall: () => this.qoe.dropStall(),
    closeStall: () => this.qoe.closeStall(this.activeSessionId()),
    reportRecovery: (pos, wait) => this.qoe.onRecovery(this.activeSessionId(), pos, wait),
    graceAfterReload: () => {
      this.qoeGraceUntil = Date.now() + 3_000;
    },
  });

  protected readonly queueCtl = inject(QueueController);
  private readonly _queueAttach = (this.queueCtl.attach({
    media: () => this.media,
    mediaId: () => this.mediaId,
    mediaFileId: () => this.mediaFileId,
    episodeId: () => this.episodeId,
    mediaLoadedTick: () => this.mediaLoadedTick(),
    preRollActive: () => this.preRollActive(),
    hasEngine: () => !!this.engine,
    engineDuration: () => this.engine?.duration,
    duration: () => this.duration(),
    isOfflinePlayback: () => this.isOfflinePlayback,
    reloadingStream: () => this.reloadingStream,
    clearEdlEnded: () => { this.edlEnded = false; },
    setBackdropUrl: (url) => this.showBackdrop(url),
    reloadForEpisode: (fileId, mediaId, episodeId) => this.reloadForEpisode(fileId, mediaId, episodeId),
  }), null);
  readonly webCrop = inject(WebVideoCropController);

  /** Not casting, and not on a pre-roll item: only then is the local playhead the one being watched. */
  private edlActive(): boolean {
    if (!this.session.isLocal()) return false;
    return !this.preRollActive() || this.mediaFileId === this.preRollMainFileId;
  }

  private readonly edl = new EdlController({
    engine: () => this.engine,
    active: () => this.edlActive(),
    duration: () => this.duration(),
    seek: (to) => this.seekInternal(to),
    end: () => {
      this.edlEnded = true;
      void this.pausePlayback();
      this.state.ended.set(true);
      if (!this.queueCtl.autoplayEnabled() || !this.queueCtl.upNext()) void this.queueCtl.markCurrentComplete();
    },
  });
  private edlEnded = false;
  readonly edlRanges = this.edl.ranges;
  readonly edlNotice = this.edl.notice;
  private readonly edlAutoSkipEffect = effect(() => {
    const on = this.authService.user()?.edlAutoSkipCommercials !== false;
    untracked(() => this.edl.setAutoSkipCommercials(on));
  });
  /** Display only: the engines do the muting. */
  readonly edlMuted = computed(() => isMutedAt(this.edl.muteRanges(), this.currentTime()));
  private readonly _webCropAttach = (this.webCrop.attach(this), null);
  readonly inPipMode = signal(false);
  /** The party dialog to show; mounting it opens it, so its code loads only when asked for. */
  protected readonly partyDialog = signal<'party' | 'reactions' | null>(null);
  protected readonly partyPanelShown = computed(() => this.partyCtl.active() && this.party.panelOpen() && !this.inPipMode());
  readonly pipAvailable = signal(true);
  protected readonly screen = new PlayerScreen({
    native: this.serverConfig.isNative,
    landscapeOnOpen: !this.device.isTv() && this.playerSettings.get().landscapeOnOpen,
    immersiveInPortrait: () => !this.paused() && !this.chrome.visible(),
    suspended: () => this.inPipMode(),
    casting: () => !this.session.isLocal(),
    onRotate: () => {
      if (this.isNativeEngine() && this.engine) this.applyNativeSubtitleStyle();
    },
  });
  readonly statsVisible = signal(false);
  readonly fillScreen = signal(false);
  /** Whether {@link applyVideoCrop} last handed mpv a crop; the overlay reads
   *  this instead of re-guessing from `pi`. */
  private readonly desktopCropApplied = signal(false);
  private readonly nativeCropApplied = signal(false);
  /** Crop stored with the offline copy; there is no playback-info to read it from. */
  private offlineCrop: OfflineCrop | null = null;
  private readonly statsRefreshTick = signal(0);
  // ── Skip-intro state ──
  /** Episode-level intro marker received in playback-info (null for movies / no marker). */
  readonly introMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Outro / end-credits marker — drives the "Épisode suivant" floating button. */
  readonly outroMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Embedded chapters from playback-info (MKV/MP4). */
  readonly chapters = signal<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  /** Set after a manual seek to suppress auto-skip for a short window. */
  private autoSkipSuppressedUntil = 0;
  /** Last processed play/pause toggle; coalesces rapid taps so play()/pause() can't interleave with an MSE
   *  append. */
  private lastTogglePlayAt = 0;
  /** Coalesce window for play/pause toggles. Sized to bridge an MSE append,
   *  not human double-tap cadence. */
  private readonly togglePlayCoalesceMs = 250;
  /** Tracks last episodeId we auto-skipped for to ensure we only auto-skip once per session. */
  private autoSkipFiredForEpisode: number | null = null;

  // ── Pre-roll state ──
  /** Item on screen; the single source of truth for every pre-roll gate. */
  private readonly preRollCurrent = signal<PreRollItem | null>(null);
  readonly preRollActive = computed(() => this.preRollCurrent() !== null);
  /** Skippable unless the plugin explicitly opts out. */
  readonly preRollSkippable = computed(() => {
    const item = this.preRollCurrent();
    return !!item && item.skippable !== false;
  });
  /** Title shown by the controls while a pre-roll item plays. */
  readonly displayEpisodeTitle = computed(() => {
    const key = this.preRollCurrent()?.labelKey;
    return key ? this.translate.instant(key) : this.episodeTitle();
  });
  /** Remaining items, consumed FIFO by {@link advancePreRoll}. */
  private preRollRest: PreRollItem[] = [];
  /** File to land on once the list is exhausted. */
  private preRollMainFileId = 0;
  /** Re-entry guard: the 'ended' latch and an error can both fire in the same tick. */
  private preRollAdvancing = false;

  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<AudioOption[]>([]);

  /** Audio tracks from streamInfo for the Cast remote */
  readonly castAudioOptions = computed<CastAudioOption[]>(() => {
    this.mediaLoadedTick(); // recompute once this.media is populated on load
    return buildCastAudioOptions(this.currentFile()?.streamInfo?.audio, this.translate);
  });

  /** True on every standalone bundle (Capacitor + Smart TV): hides fullscreen/PiP toggles. From
   *  ServerConfigService. */
  readonly isNative = this.serverConfig.isNative;
  /** Player-close animation duration; must match the `player-close` keyframes. */
  private static readonly closeAnimationMs = 200;
  /** Set while the closing animation runs, on the platforms that play it here. */
  readonly closing = signal(false);

  private readonly keyboard = new KeyboardController({
    chrome: this.chrome,
    playhead: () => (this.elsewhere() ? this.outputPlayhead() : this.engine),
    canHideControls: () => !this.elsewhere(),
    controls: () => this.controls(),
    isTv: () => this.device.isTv(),
    canControlPlayback: () => this.party.canControl(),
    playbackRate: () => this.playbackRate(),
    onTogglePlay: () => this.onTogglePlay(),
    onSeek: (t) => this.onSeek(t),
    onToggleFullscreen: () => this.onToggleFullscreen(),
    onToggleMute: () => this.onToggleMute(),
    onTogglePip: () => this.onTogglePip(),
    toggleStats: () => this.statsVisible.set(!this.statsVisible()),
    onBack: () => this.onBack(),
    onSpeedChange: (r) => this.onSpeedChange(r),
    stepFrame: (d) => this.stepFrame(d),
    reactionsAvailable: () => this.reactionDock(),
    openReactions: () => this.openReactions(),
  });
  protected readonly subs = inject(SubtitleController);
  private readonly _subsAttach = (this.subs.attach({
    engine: () => this.engine,
    isOfflinePlayback: () => this.isOfflinePlayback,
    mediaId: () => this.mediaId,
    mediaFileId: () => this.mediaFileId,
    playbackMode: () => this.playbackMode(),
    readsSubtitlesAtLoad: () => this.isNative && !this.isDesktopNative,
    reloadStream: (at, why) => this.reloadStream(at, why),
    doReloadStream: (position) => this.doReloadStream(position),
  }), null);
  protected readonly remote = inject(RemoteController);
  private readonly _remoteAttach = (this.remote.attach({
    mediaFileId: () => this.mediaFileId,
    activeSessionId: () => this.activeSessionId(),
    duration: () => this.duration(),
    onBack: () => this.onBack(),
    onTogglePlay: () => this.onTogglePlay(),
    onSeek: (t) => this.onSeek(t),
    savePosition: (force) => this.savePosition(force),
  }), null);
  private readonly remoteCommandEffect = effect(() => this.remote.onAdminEvent());
  protected readonly party = inject(PartyService);
  protected readonly reactions = inject(ReactionsService);
  /** The party reaction row exists: a party with reactions on, and the viewer kept the dock. */
  protected readonly reactionDock = computed(
    () => this.partyCtl.active() && this.party.reactionsEnabled() && this.reactions.enabled() && this.reactions.dock(),
  );
  protected readonly keyboardOverlay = inject(KeyboardOverlayService);
  protected readonly partyCtl = inject(PartySync);
  private readonly detachParty = this.partyCtl.attach({
    engine: () => this.engine,
    urlPartyId: () => +this.route.snapshot.queryParams['party'] || 0,
    openItem: (item) => this.queueCtl.openPartyItem(item),
    showControls: () => this.chrome.show(),
    releasePlayback: () => {
      if (!this.loadedPaused) return;
      this.loadedPaused = false;
      // Before the post-load step it plays by itself; after it, nothing else will.
      if (this.postLoadDone) void this.engine?.play().catch(() => this.autoplayBlocked.set(true));
    },
    onBack: () => this.onBack(),
  });

  // Sync play/pause state to PiP action button
  private readonly pipPlaybackEffect = effect(() => {
    if (!this.isNative) return;
    Pip.updatePlaybackState({ playing: !this.uiPaused() }).catch(() => {});
  });

  /** Re-apply native subtitle style on controls show/hide so the bottom-margin
      bump kicks in. Browser playback uses CSS instead — see styles below. */
  private readonly subtitleControlsMarginEffect = effect(() => {
    this.nativeSubtitleBottomBump();
    // webOS drives the DOM subtitle overlay but reports isNativeEngine=false, so it needs an explicit branch or
    // the margin never settles on controls hide.
    if ((this.isNativeEngine() || this.isWebOs) && this.engine) {
      this.applyNativeSubtitleStyle();
    }
  });

  /** Mirror fill-screen onto engines painting outside the <video> (ExoPlayer/AVPlayer); duck-typed like the
   *  subtitle style. */
  private readonly fillScreenEffect = effect(() => {
    const fill = this.fillScreen();
    const engine = this.engine as NativeEngine | null;
    if (engine && typeof engine.setFillScreen === 'function') {
      engine.setFillScreen(fill);
    }
    // contain ↔ cover changes the crop's fit math too.
    this.applyVideoCrop();
  });

  /** Push subtitle appearance to the active renderer on settings change. Untracked: the chrome.visible margin
   *  bump is owned by the effect above. */
  private readonly subtitleAppearanceEffect = effect(() => {
    this.playerSettings.settings();
    untracked(() => {
      this.applySubtitleStyle();
      if ((this.isNativeEngine() || this.isWebOs) && this.engine) {
        this.applyNativeSubtitleStyle();
      }
    });
  });

  // Media info
  private mediaFileId = 0;
  private mediaId = 0;
  private isOfflinePlayback = false;
  /** Offline playback loads no media record; the download carries the type for the back target. */
  private offlineMediaType: string | undefined;
  private episodeId: number | undefined;
  private media: Media | null = null;

  /** The title's original language (TMDB, ISO 639-1) — drives the `original`
   *  audio-selection mode. */
  private get originalLanguage(): string | null {
    return this.media?.metadata?.originalLanguage ?? null;
  }

  /** The playing file's record from `media.files`, looked up by `mediaFileId`. */
  private currentFile() {
    return this.media?.files?.find((f) => f.id === this.mediaFileId);
  }

  /** Bumped whenever {@link media} is (re)assigned so reactive computeds re-run. */
  private readonly mediaLoadedTick = signal(0);
  /** The audio the viewer should hear (index into `streamInfo.audio`): every load path configures from it, and
   *  the engine's track is reconciled to it, never the reverse. */
  private activeAudioStreamIndex: number | undefined;
  /** The picks made before pressing play; held until the file they were made on has opened. */
  private launchTracks: LaunchTracks | null = null;
  /** Track id of a switch asked of the engine and not yet seen in its reports. */
  private audioSwitchPending: string | null = null;
  /** Bumped by every audio switch: an older one that settles late must not touch the UI. */
  private audioRequest = 0;
  private audioTracksTimer: ReturnType<typeof setTimeout> | null = null;
  /** The playing file's subtitle list, fetched once: the native engine needs the
   *  sidecars before load(), the picker after it. */
  private subtitleFetch: { fileId: number; list: Promise<SubtitleOption[]> } | null = null;

  /** Files an AirPlay receiver refused in HDR: renegotiated SDR from then on. */
  private readonly sdrFallbackFileIds = new Set<number>();

  /** `deviceProfileService.getProfile()` with `rejectCopy` forced and failed audio codecs dropped when
   *  {@link CopyFallbackController} flagged the file, and HDR off once an AirPlay receiver refused it. */
  private deviceProfileFor(mediaFileId: number, passthrough = true): DeviceProfile {
    let profile = this.deviceProfileService.getProfile({ passthrough });
    if (this.copyFallback.shouldForceRejectCopy(mediaFileId)) {
      profile = { ...profile, rejectCopy: true };
    }
    const badAudio = this.copyFallback.rejectedAudioCodecs(mediaFileId);
    if (badAudio.size) {
      profile = {
        ...profile,
        directPlayProfiles: profile.directPlayProfiles.map((p) => ({
          ...p,
          audioCodecs: p.audioCodecs.filter((c) => !badAudio.has(c.toLowerCase())),
        })),
      };
    }
    if (this.sdrFallbackFileIds.has(mediaFileId)) {
      profile = { ...profile, supportsHdr: false, supportsDolbyVision: false, dolbyVisionProfiles: undefined };
    }
    return profile;
  }

  // ── CopyFallbackHost (see copy-fallback-controller.ts) ──
  isDestroyed(): boolean {
    return this.destroyed;
  }
  currentSid(): string | undefined {
    return this.playbackInfo?.sessionId;
  }
  currentMediaFileId(): number {
    return this.mediaFileId;
  }
  hasServerFeature(feature: string): boolean {
    return this.authService.hasServerFeature(feature);
  }
  isReloadIdle(): boolean {
    return !this.reloadingStream && !this.firstLoadPending && !this.recovery.active;
  }
  hasError(): boolean {
    return !!this.state.error();
  }
  failWith(e: unknown, opts?: { source?: PlaybackError['source'] }): void {
    this.state.failWith(e, opts);
  }
  setRecovering(recovering: boolean): void {
    this.state.setRecovering(recovering);
  }

  private readonly nowPlayingMeta = inject(NowPlayingMetadataService);
  /** Display metadata of the item this route plays: the one place the header, logo and backdrop read. */
  protected readonly nowPlaying = signal<NowPlayingMetadata>(NO_NOW_PLAYING);
  readonly mediaTitle = computed(() => this.nowPlaying().title);
  readonly episodeTitle = computed(() => this.nowPlaying().episodeLabel);
  readonly fanartUrl = computed(() => {
    const url = this.nowPlaying().backdropUrl;
    return url ? this.serverConfig.resolveUrl(url) : null;
  });
  /** The route's own backdrop, else the one of what another output plays. */
  protected readonly backdropUrl = computed(() => {
    const url = this.session.nowPlaying()?.backdropUrl;
    return this.fanartUrl() ?? (url ? this.serverConfig.resolveUrl(url) : null);
  });

  /** Shows `meta`; a backdrop it lacks keeps the one already painted. */
  private showNowPlaying(meta: NowPlayingMetadata): void {
    this.nowPlaying.update((cur) => ({ ...meta, backdropUrl: meta.backdropUrl ?? cur.backdropUrl }));
  }

  private showBackdrop(backdropUrl: string): void {
    this.nowPlaying.update((cur) => ({ ...cur, backdropUrl }));
  }

  /** The metadata of `media`, loaded by this route, for the item it plays. */
  private applyMedia(media: Media): void {
    this.nowPlayingMeta.prime(media);
    this.showNowPlaying(describeNowPlaying(media, this.episodeId));
  }
  /** The backdrop fades in once decoded, not on insertion. */
  protected readonly backdropLoaded = signal<string | null>(null);

  /** Low-quality `fanartUrl` for the backdrop LQIP layer; only our `/api/images/...` URLs support
   *  `?size=thumb`. */
  readonly fanartThumbUrl = computed(() => {
    const url = this.fanartUrl();
    if (!url) return null;
    if (!url.includes('/api/images/')) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}size=thumb`;
  });
  private playbackInfo: PlaybackInfoResponse | null = null;

  /** Last URL handed to the engine's load(), surfaced (token-redacted) in the
   *  error diagnostics so a failed open shows which endpoint/format was tried. */
  private lastStreamUrl = '';

  /** Live-session id for the next stream request: the cast receiver's while casting (separate ffmpeg job). */
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

    // currentTime() is deliberately not read (~4Hz, unused): the stats panel refreshes off statsRefreshTick
    // (1Hz). Read here so an engine-level track switch (no playback-info refetch) reruns this.
    const quality = this.activeQualityId();
    void this.statsRefreshTick();
    const activeAudioTrackId = this.activeAudioTrackId();
    const availableAudioTracks = this.availableAudioTracks();
    const activeVariantOriginalVideoId = this.getActiveVariant()?.originalVideoId ?? null;

    return buildPlayerStats({
      quality,
      pi: this.playbackInfo,
      engineStats: this.engine?.getStats(),
      hwAccel: this.hwAccel(),
      isOfflinePlayback: this.isOfflinePlayback,
      lastStreamUrl: this.lastStreamUrl,
      activeVariantOriginalVideoId,
      availableQualities: this.qualityManager.availableQualities(),
      resolutionLabel: (w, h) => this.qualityManager.resolutionLabel(w, h),
      transcodeTierFromVariantHeight: (h, w) => this.qualityManager.transcodeTierFromVariantHeight(h, w),
      translate: this.translate,
      sourceVideoStream: this.currentFile()?.streamInfo?.video?.[0],
      cropAppliedByPlayer: this.isDesktopNative
        ? this.desktopCropApplied()
        : this.isNativeEngine()
          ? this.nativeCropApplied()
          : this.webCrop.videoCropStyle() != null,
      isDesktopNative: this.isDesktopNative,
      // iOS PiP (AVPictureInPicture) renders the full frame, bypassing the crop;
      // Android PiP keeps the same view hierarchy, so the crop still applies.
      pipOrFullscreenActive:
        this.isPipOrNativeFullscreen() ||
        (this.isNativeEngine() && this.inPipMode() && Capacitor.getPlatform() === 'ios'),
      activeAudioTrackId,
      availableAudioTracks,
      activeAudioStreamIndex: this.activeAudioStreamIndex,
      sourceAudioStreams: this.currentFile()?.streamInfo?.audio,
    });
  });

  /** PiP or iOS native fullscreen paint the decoded frame, bypassing the CSS crop. */
  private isPipOrNativeFullscreen(): boolean {
    const video = this.videoEl()?.nativeElement as
      | (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean })
      | undefined;
    return !!video && (document.pictureInPictureElement === video || !!video.webkitDisplayingFullscreen);
  }

  // ── Lifecycle ──

  /** Offline launch on the engine this shell plays local files with. */
  private async launchOffline(localUrl: string, startTime: number | undefined): Promise<void> {
    if (this.isDesktopNative) {
      // Desktop: the original container lives on disk; mpv plays it back
      // offline (file://) with full codec coverage + embedded tracks.
      await this.createDesktopEngine();
      this.applyVideoCrop();
      await this.prepareLoad();
      await this.engine!.load(localUrl, startTime);
      await this.loadOfflineSubtitles();
    } else if (this.isNative) {
      // Android: ExoPlayer with CacheDataSource (offline HLS from cache)
      await this.createNativeEngine();
      (this.engine as NativeEngine).setOffline(true);
      this.applyNativeSubtitleStyle();
      this.applyVideoCrop();

      await this.prepareLoad();
      await this.engine!.load(localUrl, startTime, 'application/x-mpegURL');
    } else {
      // Web: Shaka offline URI ("offline:123") — IndexedDB-backed
      await this.createShakaEngine();
      this.applyVideoCrop();
      await this.prepareLoad();
      await this.engine!.load(localUrl, startTime);
    }
  }

  /** Tizen (AVPlay) and webOS (LG native <video>) share one shape: HW decoder, DOM subtitle overlay,
   *  streamInfo audio fallback, no Shaka/MSE. Only the engine instance differs. */
  private async launchTv(startTime: number | undefined): Promise<void> {
    if (this.isWebOs) {
      await this.createWebOsEngine();
    } else {
      await this.createTizenEngine();
      this.applyVideoCrop();
    }
    this.applyNativeSubtitleStyle();

    // Fetched in parallel with engine load; AVPlay's `setExternalSubtitlePath` needs READY/PLAYING, so
    // the active subtitle is attached after prepareAsync resolves.
    const tvSubsPromise = this.itemSubtitles();

    // Auth rides in the URL query (?token=); the Bearer header is for
    // AVPlay/ExoPlayer only — the webOS <video> ignores it.
    const token =
      this.authService.playbackTokenFor(this.mediaFileId);
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    const { url: tizenUrl, mimeType: tizenMimeType } = this.buildPlayUrl({
      startTime,
    });
    await this.prepareLoad();
    await this.engine!.load(tizenUrl, startTime, tizenMimeType, headers);

    // Expose to the picker only: auto-pick runs once for all engines in `autoSelectSubtitle` below (it
    // handles visibility and burn-in).
    const subs = await tvSubsPromise;
    this.subs.availableSubtitles.set(subs);
  }

  /** Android ExoPlayer / desktop mpv launch. False when the view was left during setup. */
  private async launchNative(startTime: number | undefined, mode: PlaybackMode): Promise<boolean> {
    // Subtitles arrive as HLS SUBTITLES renditions, so load() doesn't depend on this fetch; resolved
    // after load() like the Shaka path, as awaiting it first delays the first frame.
    void this.itemSubtitles();

    if (this.isDesktopNative) await this.createDesktopEngine();
    else await this.createNativeEngine();

    this.applyNativeSubtitleStyle();

    if (this.isDesktopNative) this.applyVideoCrop();

    if (this.engine instanceof NativeEngine) this.applyVideoCrop();

    const token =
      this.authService.playbackTokenFor(this.mediaFileId);
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

    // Pin the quality constraint before load so ExoPlayer can't pick 4K on a phone (A/V desync): `auto`
    // leaves ABR free, `original` pins source dimensions, a specific rung pins its width/height.
    if (mode !== 'direct' && this.engine instanceof NativeEngine) {
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
        this.engine.selectVariantTrack({ width: w, height: h });
      }
    }
    await this.prepareLoad();
    const { url: nativeUrl, mimeType: nativeMimeType } = this.buildPlayUrl({
      startTime,
    });
    // Left the view during setup: stop the engine, don't start playback.
    if (this.destroyed) {
      await this.engine?.destroy().catch(() => {});
      this.engine = null;
      return false;
    }
    await this.engine!.load(nativeUrl, startTime, nativeMimeType, headers);
    return true;
  }

  /** Web launch: Shaka with the saved-quality ABR setup and long retry windows for slow segment waits. */
  private async launchShaka(startTime: number | undefined, mode: PlaybackMode): Promise<void> {
    await this.createShakaEngine();
    this.applyVideoCrop();

    // Start subtitle loading in parallel with engine.load (Shaka doesn't need them upfront)
    void this.itemSubtitles();

    if (mode !== 'direct') {
      const savedQualityId = this.activeQualityId();
      if (savedQualityId === 'auto') {
        this.qualityManager.selectQuality(
          { id: 'auto', label: 'Auto', height: 0 },
          this.engine, mode, true,
        );
      }

      // A saved quality disables ABR; the backend serves a single-variant master, so there's one track
      // anyway.
      this.engine!.configure?.({
        abr: {
          enabled: savedQualityId === 'auto',
          defaultBandwidthEstimate: 100_000_000,
        },
        streaming: {
          // connectionTimeout defaults to 10s, well under a legitimate
          // segment wait; match it to `timeout` so it isn't cut short.
          retryParameters: {
            timeout: 60_000,
            connectionTimeout: 60_000,
            maxAttempts: 5,
            baseDelay: 1000,
          },
          // 0 opts out of Shaka's disableStream: never silently switch
          // language/quality away from what the user picked.
          maxDisabledTime: 0,
        },
        manifest: {
          retryParameters: {
            timeout: 30_000,
            connectionTimeout: 30_000,
            maxAttempts: 5,
            baseDelay: 1000,
          },
        },
      });
    }

    // `buildPlayUrl` threads `startTime` into HLS URLs (backend pre-spawns FFmpeg at the offset); direct
    // play gets the explicit `video/mp4` mimeType for Shaka.
    const { url: shakaUrl, mimeType: shakaMimeType } = this.buildPlayUrl({
      startTime,
    });
    await this.prepareLoad();
    await this.engine!.load(shakaUrl, startTime, shakaMimeType);
  }


  async ngAfterViewInit() {
    this.keyboardOverlay.enter();
    this.state.reset();
    this.qoe.reset();
    this.recovery.clearEpisode();
    this.firstLoadSetupDone = false;

    this.screen.open();

    this.webCrop.init();
    const video = this.videoEl()?.nativeElement;
    if (video) this.detachAirPlay = this.airPlay.attachVideo(video);

    // Eager backdrop from router state, set before any await so the loading screen renders on the first tick.
    const navState = (this.router.getCurrentNavigation()?.extras?.state ?? history.state) as { backdropUrl?: string | null; tracks?: LaunchTracks | null; snapshot?: PlaybackSnapshot | null } | null;
    const launch = navState?.snapshot;
    this.launchTracks = launch?.tracks ?? navState?.tracks ?? null;
    if (navState?.backdropUrl) this.showBackdrop(navState.backdropUrl);

    const qp = this.route.snapshot.queryParams;
    this.mediaFileId = +this.route.snapshot.params['mediaFileId'];
    this.mediaId = qp['mediaId'] ? +qp['mediaId'] : 0;
    this.episodeId = qp['episodeId'] ? +qp['episodeId'] : undefined;
    const resumeTime = 't' in qp ? +qp['t'] : undefined;

    // A playlist or party launch registers its queue and passes the id; consume it only on a match, any other
    // entry drops the queue (a series queue is rebuilt by syncSeriesQueue once the media loads).
    const playlistId = qp['playlistId'] ? +qp['playlistId'] : undefined;
    const partyId = qp['party'] ? +qp['party'] : undefined;
    if (
      (playlistId && this.queue.source() === 'playlist' && this.queue.sourceId() === playlistId) ||
      (partyId && this.queue.source() === 'party' && this.queue.sourceId() === partyId)
    ) {
      this.queue.syncTo(this.mediaId, this.episodeId);
    } else {
      this.queue.clear();
    }

    await this.castPlayerService.adoptSurvivingSession();
    if (this.destroyed) return;
    if (this.session.isLocal()) {
      this.attachLocalOutput();
      const completed = await this.openLocal({ position: resumeTime, paused: launch?.paused ?? false, tracks: this.launchTracks }, false);
      // Everything above awaits, so a back-out mid-launch runs ngOnDestroy first and its removals would miss the
      // listeners registered below.
      if (!completed || this.destroyed) return;
    } else {
      await this.openOnOutput(resumeTime);
      this.state.loading.set(false);
      if (this.destroyed) return;
      this.loadMediaAside();
      // A pending take-back starts the one local launch from here, at the output's position.
      this.attachLocalOutput();
    }
    this.outputFollowing = true;
    this.registerListeners();
  }

  private attachLocalOutput(): void {
    this.detachLocalOutput = this.session.attachLocal(this.localOutput);
  }

  /** Opens the local engine on the route's item, at `resumeTime` when given; false when the launch did not run to its end. */
  private async startLocal(resumeTime: number | undefined): Promise<boolean> {
    const qp = this.route.snapshot.queryParams;
    this.firstLoadSettled = new Promise<void>((resolve) => (this.settleFirstLoad = resolve));
    // Hoisted so the catch can anchor a remux fallback at the resume point.
    let startTime: number | undefined = resumeTime ?? undefined;

    // An engine `error` racing this pending load() must wait via isReloadIdle(), not
    // fire a second one. Not reloadingStream: that would drop post-load reloads (burn-in).
    this.firstLoadPending = true;
    try {
      // A finished download plays locally whatever the connectivity; `offline=1` (downloads page) insists on it.
      const forced = qp['offline'] === '1';
      const download = readyDownloadFor(this.dlCache.load(), this.mediaFileId, this.castService.isConnected());
      const offlineCheck =
        forced || download
          ? await this.offlineStorage.getLocalUrl(`download-${this.mediaFileId}`).catch(() => null)
          : null;
      if (forced && !offlineCheck) {
        this.state.setError(this.translate.instant('player.offline_not_found'), {
          source: 'session',
        });
        return false;
      }
      if (offlineCheck) {
        this.isOfflinePlayback = true;
        this.offlineCrop = download?.offlineCrop ?? null;
        this.offlineMediaType = download?.media?.type;
      }

      // playback-info runs once the media is known: its audio index picks the DEFAULT rendition, and
      // startQuality/startAt let the backend pre-spawn ffmpeg.
      await this.deviceProfileService.whenDesktopProbed();
      // The service is app-scoped: without this the request would carry the
      // previous media's rung instead of the user's saved one.
      this.qualityManager.restorePreference();
      let playbackInfoPromise: ReturnType<StreamingApiService['getPlaybackInfo']> | null = null;
      const requestPlaybackInfo = () => {
        if (this.isOfflinePlayback || playbackInfoPromise) return;
        // The launch failure path shows the server's reason in its own toast and card.
        playbackInfoPromise = this.negotiatePlayback(resumeTime, {}, {
          skipErrorToast: true,
          preRollFirst: this.preRollMayRun(resumeTime),
        });
      };
      // Minted in parallel with the other loads (time-to-first-frame critical path); awaited before headers are
      // built.
      const streamTokenPromise = this.isOfflinePlayback
        ? null
        : this.requireStreamToken();
      streamTokenPromise?.catch(() => {});

      // Load media info + playback state in parallel
      // No stopSessions here — getOrCreateSession handles stale sessions naturally
      if (this.mediaId && !this.isOfflinePlayback) {
        const mediaPromise = this.mediaService.getOne(this.mediaId);
        const media = await mediaPromise;
        this.media = media;
        this.resolveAudioTarget();
        await this.planSubtitleDelivery();
        requestPlaybackInfo();

        this.mediaLoadedTick.update(v => v + 1);
        this.applyMedia(media);

        const file = media.files?.find((f: any) => f.id === this.mediaFileId);
        this.queueCtl.syncSeriesQueue();

        // Use duration from streamInfo (reliable, from ffprobe)
        const si = file?.streamInfo as any;
        const knownDuration = si?.durationSeconds;
        if (knownDuration && knownDuration > 0) {
          this.state.duration.set(knownDuration);
        }
      }

      // The server's resume point (another device may have advanced it) wins when it answers; else this device's last.
      if (startTime == null && this.isOfflinePlayback && this.mediaId && this.network.isOnline()) {
        const st = await this.streamingApi.getPlaybackState(this.mediaId, this.episodeId).catch(() => null);
        if (st && !st.completed && st.positionSeconds > 10) startTime = st.positionSeconds;
      }
      if (startTime == null && this.isOfflinePlayback && this.mediaId) {
        const local = this.offlineSync.resumePositionFor(this.mediaId, this.episodeId);
        if (local && local.positionSeconds > 10) startTime = local.positionSeconds;
      }
      this.pendingStartTime = startTime ?? 0;

      if (this.isOfflinePlayback) {
        const offlineTask = this.dlCache
          .load()
          .find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
        this.applyOfflineHeader(offlineTask);
        this.loadMediaAside();
        const offlineEdl = this.authService.user()?.edlEnabled === false ? undefined : offlineTask?.offlineEdl;
        this.edl.load(this.mediaFileId, offlineEdl);
        startTime = this.edlStartTime(startTime);
        this.state.playbackMode.set('direct');
        this.qualityManager.availableQualities.set([]);
        this.lastStreamUrl = offlineCheck ?? '';
        this.resolveAudioTarget();

        await this.launchOffline(offlineCheck!, startTime);
      } else {
        // Await playback-info (kicked off in parallel with media load above)
        requestPlaybackInfo();
        this.playbackInfo = await playbackInfoPromise!;
        startTime ??= this.playbackInfo.startAtSeconds || undefined;
        this.pendingStartTime = startTime ?? 0;
        await this.maybeStartPreRoll(startTime);
        // No item played (every one failed to negotiate): the film opens now, the way a plugin-free launch does.
        if (this.playbackInfo.deferred && !this.preRollActive()) {
          this.playbackInfo = await this.negotiatePlayback(resumeTime, {}, { skipErrorToast: true });
        }
        const pi = this.playbackInfo!;

        // Mode, options + the rung the backend locked in, BEFORE load
        this.adoptPlaybackInfo(pi);
        startTime = this.edlStartTime(startTime);

        const mode = this.playbackMode();

        // Cache the file's stream JWT before building URLs and Bearer headers: ExoPlayer/AVPlay/Shaka bake auth at
        // load() and the 1h access token would expire mid-film. A pre-roll swapped the file since the mint.
        if (streamTokenPromise) {
          await streamTokenPromise;
          await this.requireStreamToken();
        }

        // Native (Capacitor) uses the platform player, Samsung Tizen uses AVPlay (Shaka's MSE chokes on Tizen
        // 6.5: EAC3 claims support but `addSourceBuffer` throws); web keeps Shaka.
        if (this.isTizen || this.isWebOs) {
          await this.launchTv(startTime);
        } else if (this.isDesktopNative || this.isNative) {
          if (!(await this.launchNative(startTime, mode))) return false;
        } else {
          await this.launchShaka(startTime, mode);
        }
      }

      this.firstLoadPending = false;
      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, this.playbackMode());
      this.firstLoadSetupDone = true;
      await this.completePostLoadSetup();

    } catch (e: any) {
      console.error('[Player] Init error:', e?.code, e?.category, e?.data, e);
      const recovered = () => {
        if (this.firstLoadSetupDone) return;
        this.firstLoadSetupDone = true;
        return this.completePostLoadSetup();
      };
      if (!this.fallBackFromRemuxOnLoadError(e, startTime ?? 0, recovered)) {
        const userMessage = this.state.failWith(e, { dolbyVision: this.isDolbyVisionPassthrough() });
        // preRollAdvanceEffect handles a pre-roll failure; this teardown would
        // null the engine it needs, and the toast has no film-error to show.
        if (!this.preRollActive()) {
          // TV/native engines leave their surface parked over the error overlay
          // if they die during load(): tear it down so the card is visible.
          if ((this.isTizenEngine() || this.isDesktopNative || this.isNativeEngine()) && this.engine) {
            releaseEngineSurface();
            const video = this.videoEl()?.nativeElement;
            if (video) video.style.display = '';
            try {
              await this.engine.destroy();
            } catch {
              /* engine state may already be torn down - fine */
            }
            this.engine = null;
            this.isTizenEngine.set(false);
            this.isNativeEngine.set(false);
          }
          // Fixed z-[9999] on the always-mounted <app-toast-container>: survives
          // even when the player-container itself isn't laying out correctly.
          try {
            this.toast.error(userMessage);
          } catch {
            /* toast service may not be ready during early init - ignore */
          }
        }
      }
    } finally {
      this.state.loading.set(false);
      this.firstLoadPending = false;
      this.settleFirstLoad();
    }
    return true;
  }

  private registerListeners(): void {
    // Keyboard shortcuts
    document.addEventListener('keydown', this.keyboard.onKeyDown);

    // Best-effort cleanup on unload; `pagehide` too because iOS Safari/WebView often skips `beforeunload`
    // (bfcache, backgrounding), which would leave the ffmpeg session until its idle GC.
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('pagehide', this.onBeforeUnload);
    if (this.isTizen || this.isWebOs) document.addEventListener('visibilitychange', this.onTvVisibility);

    // PiP mode change listener (native Android)
    if (this.isNative) {
      Pip.isAvailable().then(({ available }) => this.pipAvailable.set(available)).catch(() => this.pipAvailable.set(false));
      window.addEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.addEventListener('pipAction', this.onPipAction as EventListener);
      this.pipWired.set(true);
      // Leaving the app (Home, PiP, lock) may be followed by a kill: save the position now.
      void CapApp.addListener('pause', () => void this.savePosition(true)).then((h) => {
        if (this.destroyed) void h.remove();
        else this.appPauseListener = h;
      });
    }
    // app.ts dispatches 'app:playerBack' on hardware/gesture back while on /watch, so it takes the same
    // onBack() path as the back arrow (replaceUrl to media detail).
    window.addEventListener('app:playerBack', this.onPlayerBackEvent);
    // The desktop shell's OS media controls ask for a seek here, so a transcode seek renegotiates like a scrub.
    this.stopDesktopSeekRequests = window.fliksDesktop?.on((e) => {
      if (e.type === 'seekRequest') this.onSeek(e.payload.position);
    });
  }

  private stopDesktopSeekRequests: (() => void) | undefined;

  ngOnDestroy() {
    this.destroyed = true;
    this.stopDesktopSeekRequests?.();
    this.keyboardOverlay.leave();
    this.edl.clear();
    this.webCrop.destroy();
    this.detachAirPlay();
    if (this.forcedSaveTrailing) clearTimeout(this.forcedSaveTrailing);
    this.remote.dispose();
    this.detachParty();
    this.detachLocalOutput();
    this.savePosition();
    this.qoe.setStalled(false, { sessionId: this.activeSessionId(), position: this.engine?.currentTime ?? 0 });
    this.qoe.flushKeepalive(this.activeSessionId());
    if (this.session.isLocal()) {
      // keepalive fetch (not HttpClient) so the stop survives if this destroy
      // coincides with a page unload / app background.
      this.fireAndForgetStopSessions();
    }
    if (this.engine) {
      if (this.isNativeEngine()) {
        releaseEngineSurface();
      }
      this.engine.destroy().catch(() => {});
      // Drop the reference so any late async (recovery / cast resume) can't
      // reload a torn-down engine and relaunch playback in the background.
      this.engine = null;
    }
    this.removeSubtitleStyle();
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.removeEventListener('seeking', this.onSeeking);
      video.removeEventListener('seeked', this.onSeeked);
    }
    this.spriteAbort?.abort();
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.cues.cancelTimers();
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.playheadInterval) clearInterval(this.playheadInterval);
    this.recovery.dispose();
    document.removeEventListener('keydown', this.keyboard.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('pagehide', this.onBeforeUnload);
    document.removeEventListener('visibilitychange', this.onTvVisibility);
    window.removeEventListener('app:playerBack', this.onPlayerBackEvent);
    this.screen.close();
    if (this.isNative) {
      Pip.setAutoEnter({ enabled: false }).catch(() => {});
      window.removeEventListener('pipModeChanged', this.onPipModeChanged as EventListener);
      window.removeEventListener('pipAction', this.onPipAction as EventListener);
      void this.appPauseListener?.remove();
    }
  }

  // ── Pre-roll ──

  /** The start position moved past any cut or commercial that covers it. */
  private edlStartTime(startTime: number | undefined): number | undefined {
    const t = startTime ?? 0;
    const resolved = this.edl.resolveStart(t);
    if (resolved === t) return startTime;
    this.pendingStartTime = resolved;
    return resolved;
  }

  /** Whether a pre-roll may take over this launch, so the server can leave the film's session closed. */
  private preRollMayRun(startTime: number | undefined): boolean {
    return !startTime && !this.isOfflinePlayback && this.session.isLocal()
      && this.route.snapshot.queryParams['noPreRoll'] !== '1';
  }

  /** Take over the launch with the plugin's pre-roll list when the response
   *  carries one. No-op on resume, offline, Cast, or when nothing negotiates. */
  private async maybeStartPreRoll(
    startTime: number | undefined,
  ): Promise<void> {
    const items = this.playbackInfo?.preRoll ?? [];
    if (!items.length || !this.preRollMayRun(startTime)) return;

    const mainFileId = this.mediaFileId;
    const mainSid = this.playbackInfo!.sessionId;
    const rest = [...items];
    while (rest.length) {
      const item = rest.shift()!;
      const info = await this.negotiatePlayback(undefined, { fileId: item.mediaFileId }).catch(() => null);
      if (!info) continue; // this candidate failed to negotiate — try the next
      // Only stop the main session once a pre-roll item is committed: if every
      // candidate fails, the launch is byte-identical to a plugin-free one.
      if (mainSid) await this.streamingApi.stopSession(mainSid).catch(() => {});
      this.preRollMainFileId = mainFileId;
      this.preRollRest = rest;
      this.preRollCurrent.set(item);
      this.mediaFileId = item.mediaFileId;
      this.playbackInfo = info;
      this.state.duration.set(info.source?.durationSeconds ?? 0);
      return;
    }
  }

  /** Move past the item on screen: the next pre-roll item, else the main video.
   *  Reuses {@link reloadForEpisode} for every transition, main item included. */
  private async advancePreRoll(): Promise<void> {
    if (!this.preRollActive() || this.preRollAdvancing) return;
    this.preRollAdvancing = true;
    try {
      // `reloadForEpisode` refuses while another reload is in flight. Consuming the item first
      // would strand the run on a finished one, with nothing left to re-trigger this.
      await this.copyFallback.waitForReloadIdle();
      const next = this.preRollRest.shift();
      if (next) this.preRollCurrent.set(next);
      const fileId = next ? next.mediaFileId : this.preRollMainFileId;
      this.state.ended.set(false);
      this.state.error.set(null);
      await this.reloadForEpisode(fileId, this.mediaId, this.episodeId, { noResumeLookup: true });
      // Any refusal above is silent, so the loaded file is the only proof it happened.
      if (this.mediaFileId !== fileId) this.remountWithoutPreRoll();
    } finally {
      // Guards lift only once the main item is the loaded file — a chained
      // failure re-enters this before landing there.
      if (this.mediaFileId === this.preRollMainFileId) this.preRollCurrent.set(null);
      this.preRollAdvancing = false;
    }
  }

  /** Skip-button handler — drops the item on screen; any remaining items still play. */
  skipPreRoll(): void {
    void this.advancePreRoll();
  }

  /** Pre-roll chains unconditionally on end or error — autoplay settings don't
   *  apply, and a failure must never be able to stop the main video. */
  private readonly preRollAdvanceEffect = effect(() => {
    if (!this.preRollActive()) return;
    if (!this.state.ended() && !this.state.error()) return;
    // Without an engine there is nothing to load into, so the run cannot continue in place.
    if (!this.engine) {
      this.remountWithoutPreRoll();
      return;
    }
    void this.advancePreRoll();
  });

  /** Remount on the main item with `noPreRoll=1` so the fresh mount doesn't
   *  retry a pre-roll that died before it could be advanced in place. */
  private remountWithoutPreRoll(): void {
    // The gate stays on until this component dies: teardown calls savePosition, and with it
    // cleared the trailer's playhead would land on the main film's row.
    const qp = { ...this.route.snapshot.queryParams, noPreRoll: '1' };
    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() =>
        this.router.navigate(['/watch', this.preRollMainFileId], {
          queryParams: qp,
          replaceUrl: true,
        }),
      );
  }

  // ── Engine factories ──

  private async createShakaEngine(): Promise<void> {
    const { engine } = await this.createSurface('shaka');
    this.engine = engine;
    this.isNativeEngine.set(false);
    this.state.bindEngine(engine);

    // videoStarted flips on the engine 'firstFrame' (frame presented to the compositor); the DOM 'playing'
    // event can precede first paint and would hide the fanart backdrop too early.
    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireAudioTracks(engine);
    this.wireErrorRecovery(engine);
  }

  private async createWebOsEngine(): Promise<void> {
    // webOS plays through the same visible <video> as Shaka, with no transparent hardware plane, so the Shaka
    // UX (isNativeEngine=false) fits.
    const { engine } = await this.createSurface('webos');
    this.engine = engine;
    this.isNativeEngine.set(false);
    this.state.bindEngine(engine);

    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireAudioTracks(engine);
    this.wireErrorRecovery(engine);
  }

  private async createTizenEngine(): Promise<void> {
    const { engine } = await this.createSurface('tizen');
    this.engine = engine;
    this.isTizenEngine.set(true);
    // Group with the native-engine UX; code gated on `!isNativeEngine()` would otherwise treat AVPlay as a
    // Shaka session and attach <video> listeners we no longer own.
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireAudioTracks(engine);
    this.wireErrorRecovery(engine);
  }

  private async createNativeEngine(): Promise<void> {
    const { engine } = await this.createSurface('native');
    if (engine instanceof NativeEngine) {
      engine.cropSupported = this.deviceProfileService.nativeCropsBlackBars();
      if (this.playerSettings.get().backgroundAudio) {
        engine.mediaInfo = () => {
          const art = this.media?.fanartUrl || this.media?.posterUrl;
          return {
            ...mediaSessionText(this.nowPlaying()),
            artworkUrl: art ? this.serverConfig.resolveUrl(imageUrlWithSize(art, 'medium')) : undefined,
          };
        };
        engine.onNext = () => void this.queueCtl.advance();
        engine.onPrevious = () =>
          void this.queueCtl.playPrevious();
        engine.onStop = () => this.onBack();
        engine.onToggleLike = () => void this.queueCtl.notificationLike.toggle();
      }
    }
    this.wireNativePlayerEngine(engine);
  }

  private async createDesktopEngine(): Promise<void> {
    const { engine } = await this.createSurface('desktop');
    this.wireNativePlayerEngine(engine);
  }

  /** Engine plus the surface contract that goes with it; the wiring below is
   *  this player's own. */
  private async createSurface(kind: EngineSurfaceKind) {
    const surface = await createEngineSurface({
      kind,
      video: this.videoEl()!.nativeElement,
      container: this.containerEl()?.nativeElement,
    });
    this.edl.attach(surface.engine);
    return surface;
  }

  /** What the engine's next load() opened paused, so the post-load `play()` is skipped. */
  private loadedPaused = false;
  /** The first load's post-load step ran (it issues the solo autoplay). */
  private postLoadDone = false;
  /** The engine itself was opened paused: a native engine then needs an explicit `play()` once released. */
  private openedPaused = false;

  /** Playback came back from another output that was paused: the next load opens paused. */
  private resumePaused = false;

  /** Engines that can open paused do so for a party that is not playing; the others autoplay and the party pauses them. */
  private armStartPaused(engine: PlaybackEngine): void {
    if (engine.startPaused === undefined) {
      // A hand-back from a paused output skips the post-load play instead.
      this.loadedPaused = this.resumePaused;
      return;
    }
    engine.startPaused = this.loadedPaused = this.openedPaused = this.partyCtl.startsPaused() || this.resumePaused;
  }

  /** Shared wiring for the transparent-overlay native engines (ExoPlayer/AVPlayer, Electron mpv): bind state,
   *  surface the first frame, arm session-expired recovery. */
  private wireNativePlayerEngine(engine: PlaybackEngine): void {
    this.wireAudioTracks(engine);
    this.engine = engine;
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    // videoStarted flips on 'firstFrame' so spinner+fanart stay until the surface paints; a 'playing'
    // stateChanged hook would be too early.
    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireErrorRecovery(engine);
    if (engine instanceof NativeEngine) engine.on('timeUpdate', this.heartbeatOnNativeTick);
  }

  /** The playing file's audio stream info, in engine track order; offline it is the metadata captured at
   *  download. */
  private audioStreamInfo(): AudioStreamChoice[] {
    if (this.isOfflinePlayback) {
      const task = this.dlCache
        .load()
        .find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
      return task?.audioStreams ?? [];
    }
    const file = this.currentFile();
    return (file?.streamInfo as any)?.audio ?? [];
  }

  /** Feeds every report of the engine's audio tracks into {@link adoptAudioTracks}. */
  private wireAudioTracks(engine: PlaybackEngine): void {
    engine.on('audioTracksChanged', (e) => this.adoptAudioTracks(e.tracks));
  }

  /** The launch pick, for the file it was made on only: not an episode switch, nor a pre-roll item. */
  private launchPick(): LaunchTracks | null {
    return launchPickFor(this.launchTracks, this.mediaFileId);
  }

  /** The audio the item opens on, known before any engine reports a track: the
   *  remembered pick, else the mode's language, else the file's default. */
  private resolveAudioTarget(): void {
    this.activeAudioStreamIndex = this.playerSettings.resolveAudioStreamIndex(
      this.mediaFileId, this.audioStreamInfo(), this.mediaId, this.originalLanguage,
      this.launchPick()?.audioStreamIndex,
    );
  }

  /** Engine tracks labelled from streamInfo (engines list them in its order), so
   *  the menu reads like the media-detail header. */
  private describeAudioTracks(raw: AudioTrack[]): (AudioOption & { selected: boolean })[] {
    const streams = this.audioStreamInfo();
    return raw.map((t, i) => {
      const parts = streams[i] ? formatAudioParts(streams[i], this.translate, i + 1) : null;
      const fallback = t.label || this.translate.instant('player.audio_track_n', { index: i + 1 });
      return {
        id: t.id,
        label: streams[i] ? formatAudioLabel(streams[i], this.translate, i + 1) : fallback,
        menuHead: parts?.head ?? fallback,
        menuSub: parts?.sub ?? '',
        language: normalizeLangCode(t.language),
        selected: !!t.selected,
        supported: t.supported,
      };
    });
  }

  private isAudioPlayable(trackId: string): boolean {
    return this.availableAudioTracks().find((t) => t.id === trackId)?.supported !== false;
  }

  /** Takes the audio tracks the engine (or streamInfo fallback) offers: refreshes the menu, never shrinking it
   *  on a partial report, then reconciles the engine's active track with the target. */
  private adoptAudioTracks(raw: AudioTrack[]): void {
    const tracks = this.describeAudioTracks(raw);
    if (!tracks.length) return;
    const existing = this.availableAudioTracks();
    const sameList = tracks.length === existing.length && tracks.every((t, i) => t.id === existing[i].id && t.supported === existing[i].supported);
    if (tracks.length >= existing.length && !sameList) this.availableAudioTracks.set(tracks);
    const list = this.availableAudioTracks();
    const active = tracks.find((t) => t.selected)?.id ?? null;
    this.reconcileAudio(list, list.some((t) => t.id === active) ? active : null);
  }

  /** Makes the engine play the target audio and the menu show it; `engineActive` is null if the engine is
   *  silent. A requested switch counts as done until reported, so a stale report neither repeats nor loops. */
  private reconcileAudio(tracks: AudioOption[], engineActive: string | null): void {
    const idx = this.activeAudioStreamIndex;
    const target = idx == null ? undefined : trackForStreamIndex(idx, this.audioStreamInfo(), tracks);
    if (!target || target.supported === false) {
      this.reconcileActiveAudioTrack(tracks, engineActive);
      return;
    }
    this.activeAudioTrackId.set(target.id);
    if (engineActive === target.id) this.audioSwitchPending = null;
    else if (engineActive && this.audioSwitchPending !== target.id) {
      this.applyAudioTrack(target.id).catch((e) => console.warn('[player] audio reconcile failed', e));
    }
  }

  /** Extra bottom margin (vh) keeping native-renderer cues clear of the bar —
   *  halved for the seek OSD, which is a fraction of the full bar's height. */
  private nativeSubtitleBottomBump(): number {
    if (!this.chrome.visible()) return 0;
    return this.chrome.seekOsd() ? 5 : 10;
  }

  /** Clears the top bar, which the seek OSD hides. */
  private nativeSubtitleTopBump(): number {
    return this.chrome.visible() && !this.chrome.seekOsd() ? 10 : 0;
  }

  // ── Player actions ──

  /** The sync tool pauses and plays locally; closing it rejoins the group. */
  onCloseSubtitleSync() {
    this.subs.onCloseSubtitleSync();
    if (this.partyCtl.active()) this.partyCtl.resync();
  }

  private outputPlayhead(): { paused: boolean; currentTime: number } | null {
    const o = this.elsewhere();
    return o && { paused: o.paused(), currentTime: o.position() };
  }

  /** The cast receiver or remote target while playback is there, else null. */
  protected elsewhere(): PlaybackOutput | null {
    return this.session.isLocal() ? null : this.session.output();
  }

  protected onNext(): void {
    if (!this.session.command({ type: 'next' })) void this.queueCtl.advance();
  }

  /** Stopping on a cast ends the session's media, so there is nothing left to show here. */
  protected onStopOutput(o: PlaybackOutput): void {
    o.stopPlayback();
    if (!o.hasMedia()) this.onBack();
  }

  onTogglePlay() {
    if (this.elsewhere()) {
      this.session.command({ type: 'toggle' });
      return;
    }
    if (!this.engine) return;
    if (!this.subs.subtitleSyncOpen() && this.session.command({ type: 'toggle' })) return;
    // Coalesce rapid taps: a second toggle inside this window is dropped so play()/pause() can't interleave
    // with an in-flight MSE append and desync A/V.
    const now = Date.now();
    if (now - this.lastTogglePlayAt < this.togglePlayCoalesceMs) return;
    this.lastTogglePlayAt = now;
    // Like a natural end, play after an EDL end replays from the start.
    if (this.edlEnded && this.state.ended()) {
      this.edlEnded = false;
      this.state.ended.set(false);
      const t = this.edl.resolveSeek(0);
      if (t !== null) this.seekInternal(t);
    }
    // Decide off what the control shows, so a tap during launch pauses.
    if (this.uiPaused()) {
      this.playPlayback();
      this.chrome.resetHideTimer();
    } else {
      void this.pausePlayback();
    }
  }

  /** Every intentional play goes through here. The control shows it at once: desktop mpv's stateChanged can
   *  lag ~1s and a reload swallows it; the engine event reasserts, a rejected command reverts. */
  private playPlayback(): void {
    this.state.paused.set(false);
    this.engine?.play().catch(() => {
      const paused = this.engine?.paused ?? true;
      this.state.paused.set(paused);
      if (paused) this.state.buffering.set(false);
    });
  }

  /** Every intentional pause goes through here so the launch stops counting as
   *  in flight. */
  private pausePlayback(): Promise<void> {
    this.state.startingPlayback.set(false);
    this.state.paused.set(true);
    return (this.engine?.pause() ?? Promise.resolve()).catch(() =>
      this.state.paused.set(this.engine?.paused ?? true),
    );
  }

  onSeekDragChange(dragging: boolean) {
    this.seekDragging.set(dragging);
    if (dragging) {
      // Freeze the engine→state mirror while dragging so `timeUpdate` doesn't push the bar back under the
      // user's finger. Local only: another output takes the seek, and nothing here would release the lock.
      if (this.session.isLocal()) this.state.seekLocked.set(true);
      // A hidden seekbar kept the focus and took the arrow before the page handler: raise the seek OSD here.
      if (!this.chrome.visible()) this.chrome.show(true);
    } else {
      this.chrome.resetHideTimer();
      // Keep the lock: `onSeek` fires next with the commit value and schedules its own release.
    }
  }

  onSeek(time: number) {
    if (this.session.command({ type: 'seek', at: time })) return;
    const dur = this.duration();
    if (!dur) {
      // Clamping to Math.min(time, 0) would jump to the start and report
      // position 0 back as truth instead of dropping a too-early seek.
      console.warn('[player] onSeek: rejecting seek before duration is known', time);
      return;
    }
    const requested = Math.max(0, Math.min(time, dur));
    if (this.edlEnded) {
      this.edlEnded = false;
      this.state.ended.set(false);
    }
    const t = this.edl.resolveSeek(requested);
    if (t === null) return;
    this.seekInternal(t);
    // Suppress auto-skip for 2s after a manual seek so the user can step back
    // into the intro on purpose without being kicked forward again.
    this.autoSkipSuppressedUntil = Date.now() + 2000;
    this.chrome.resetHideTimer();
  }

  private readonly injector = inject(Injector);

  /** The reaction row alone, open, on the emoji last focused there (else the first): the controls stay down. */
  private openReactions(): void {
    this.chrome.showReactions();
    afterNextRender(
      () => {
        const last = this.reactions.lastFocused;
        const row = document.querySelector('app-party-reaction-dock');
        const emoji = (last && row?.querySelector<HTMLElement>(`[data-emoji="${CSS.escape(last)}"]`)) || row?.querySelector<HTMLElement>('.emoji');
        emoji?.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  /** Seek with the lock and the desktop far-seek reload; not a user seek for the intro auto-skip. */
  private seekInternal(t: number) {
    if (this.engine) {
      // Lock before seeking so `timeUpdate` events still reporting the OLD position can't bounce the bar back;
      // `state.currentTime.set(t)` pins it at the target until `awaitSeekUnlock` releases.
      this.state.seekLocked.set(true);
      this.state.currentTime.set(t);
      // A seek to 0 is the user's, not an unsettled load.
      this.pendingStartTime = 0;
      this.lastSeekAt = Date.now();
      if (this.desktopFarSeekNeedsReload(t)) void this.seekByReload(t);
      else void this.awaitSeekUnlock(t);
    }
    // Every engine funnels through here, unlike the DOM `seeked` event (<video> only), so desktop/native seeks
    // reach a controller before the next heartbeat.
    void this.savePosition(true);
  }

  /** Step one frame, pausing first. Falls back to 24 fps when the source rate
   *  is unknown — a slightly wrong step beats a dead key. */
  private stepFrame(direction: -1 | 1) {
    if (!this.engine) return;
    const fps = Number(this.playbackInfo?.source?.frameRate) || 24;
    if (!this.engine.paused) this.onTogglePlay();
    this.onSeek(this.engine.currentTime + direction / fps);
  }

  /** Generation counter bumped by every `onSeek`, so a newer seek invalidates an older `awaitSeekUnlock`
   *  mid-flight (e.g. a held arrow key). */
  private seekGeneration = 0;

  /** Await the engine's seek completion before lifting the state lock: its promise (a reject keeps the lock),
   *  then poll `currentTime` to within 2s (Shaka resolves early); force-unlocks after 30 s (ffmpeg respawn). */
  private async awaitSeekUnlock(target: number): Promise<void> {
    const gen = ++this.seekGeneration;
    try {
      await this.engine?.seek(target);
    } catch {
      // The rejection (Tizen's 35 s timeout) emits no error, so lifting the lock here is what frees the bar.
      if (gen === this.seekGeneration) this.state.seekLocked.set(false);
      return;
    }
    // AVPlay has no getSpeed(), so a rate it drops on its own is invisible:
    // re-assert the user's pick after every seek rather than trust it held.
    this.restorePlaybackRate();
    await this.pollSeekConverge(target, gen);
  }

  /** Poll the engine's reported position until it lands within 2s of the seek
   *  target, then release the seekbar lock. Gen-guarded so a newer seek wins. */
  private async pollSeekConverge(target: number, gen: number): Promise<void> {
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

  /** Desktop mpv multi-audio HLS only: true when `target` falls outside mpv's
   *  demuxer cache, forcing a reload (see {@link seekByReload}) instead of an in-place seek. */
  private desktopFarSeekNeedsReload(target: number): boolean {
    if (
      !this.isDesktopNative ||
      !(this.engine instanceof DesktopEngine) ||
      this.playbackMode() === 'direct' ||
      this.availableAudioTracks().length <= 1
    ) {
      return false;
    }
    const pos = this.engine.currentTime;
    const bufferedEnd = this.engine.buffered;
    return (
      target > bufferedEnd + this.desktopSeekCacheSlackS ||
      target < pos - this.desktopSeekBackWindowS
    );
  }

  /** Far-seek path: reload the stream anchored at `target` instead of seeking in place, then release the
   *  seekbar lock once the playhead converges. Serialised against other reloads via {@link reloadingStream}. */
  private async seekByReload(target: number): Promise<void> {
    const gen = ++this.seekGeneration;
    if (this.reloadingStream) {
      void this.awaitSeekUnlock(target);
      return;
    }
    this.reloadingStream = true;
    this.state.loading.set(true);
    this.engine?.resetRecoveryGuard();
    try {
      const reloaded = await this.refreshSidAndReload(target, {
        preservePause: true,
        unmute: false,
      });
      // The fallback reload anchors at `target` itself; polling here would hold
      // the reload guard it waits on.
      if (!reloaded) {
        this.state.loading.set(false);
        this.state.seekLocked.set(false);
        return;
      }
      this.recovery.resetStallWatchdog();
      this.state.loading.set(false);
      await this.pollSeekConverge(target, gen);
    } catch (e) {
      console.error('[Player] far-seek reload failed:', e);
      this.state.loading.set(false);
    } finally {
      this.reloadingStream = false;
      this.qoeGraceUntil = Date.now() + 3_000;
      this.drainPendingReload();
    }
  }

  // ── Skip-intro UX ──

  protected readonly cues = new CueController({
    edl: this.edl,
    chrome: this.chrome,
    preRollActive: () => this.preRollActive(),
    introMarker: () => this.introMarker(),
    outroMarker: () => this.outroMarker(),
    currentTime: () => this.currentTime(),
    upNext: () => this.queueCtl.upNext(),
    engaged: () => this.chrome.visible() || (this.controls()?.cueFocused() ?? false),
    hasEngine: () => !!this.engine,
    seek: (t) => this.seekInternal(t),
  });
  private readonly localOutput = new LocalPlaybackOutput(
    {
      engine: () => this.engine,
      mediaId: () => this.mediaId,
      episodeId: () => this.episodeId,
      seekTo: (t) => this.seekInternal(t),
      pausePlayback: () => this.pausePlayback(),
      playLocal: () => this.playPlayback(),
      position: () => (this.state.seekLocked() ? this.state.currentTime() : (this.engine?.currentTime ?? 0)),
      spriteUrl: this.spriteUrl,
      spriteMetadata: this.spriteMetadata,
      subtitles: this.subs.availableSubtitles,
      audioTracks: this.availableAudioTracks,
      qualities: this.qualityManager.availableQualities,
      activeSubtitleId: this.subs.activeSubtitleId,
      activeAudioTrackId: this.activeAudioTrackId,
      activeQualityId: this.activeQualityId,
      skipCue: computed(() => {
        if (this.cues.commercialCueVisible()) return { labelKey: 'player.edl.skip_commercial' };
        return this.cues.skipIntroVisible() ? { labelKey: 'player.skip_intro' } : null;
      }),
      timeline: computed(() => ({
        intro: this.introMarker(),
        outro: this.outroMarker(),
        chapters: this.chapters(),
        edl: this.edl.ranges(),
      })),
      canPlayNext: computed(() => this.queueCtl.upNext() !== null),
      skip: () => this.cues.onSkipCue(),
      playNext: () => void this.queueCtl.advance(),
      selectSubtitle: (id) => this.subs.selectById(id),
      selectAudio: (id) => this.onSelectAudioTrack(id),
      selectQuality: (id) => this.onSelectQualityById(id),
      onBack: () => this.onBack(),
      release: () => this.releaseForHandoff(),
      stepAside: () => this.stepAside(),
      snapshot: () => this.snapshot(),
      resume: (snapshot) => this.resumeLocal(snapshot),
    },
    this.state,
  );
  private detachLocalOutput: () => void = () => {};

  private readonly cueTimerPauseEffect = effect(() => this.cues.syncTimers());
  private readonly skipIntroCueEffect = effect(() => this.cues.syncIntroCue());
  private readonly commercialCueEffect = effect(() => this.cues.syncCommercialCue());
  private readonly nextEpisodeCueEffect = effect(() => this.cues.syncNextEpisodeCue());

  /** Auto-skip when the cursor enters the intro window, the setting is on, this episode wasn't already
   *  auto-skipped, and there was no manual seek in the last 2s. */
  private readonly autoSkipEffect = effect(() => {
    if (!this.cues.inIntroRange()) return;
    if (!this.playerSettings.get().autoSkipIntro) return;
    if (Date.now() < this.autoSkipSuppressedUntil) return;
    const epId = this.episodeId ?? -1;
    if (this.autoSkipFiredForEpisode === epId) return;
    this.autoSkipFiredForEpisode = epId;
    this.cues.skipIntro();
  });

  private readonly notificationLikeEffect = effect(() => this.queueCtl.trackNotificationLike());
  private readonly notificationNavEffect = effect(() => this.queueCtl.syncNotificationNav());
  private readonly autoAdvanceEffect = effect(() => this.queueCtl.autoAdvance());

  /** The header from the download, so it shows offline; online, the media fetch fills in what the download lacks. */
  private applyOfflineHeader(task: DownloadTask | undefined): void {
    if (!task) return;
    this.showNowPlaying(this.nowPlayingMeta.describeDownload(task));
  }

  /** Fetch the media record off the launch path, for a local copy or an item another output plays: the header,
   *  next episode and series queue need it; the stream, tracks and subtitles do not. */
  private loadMediaAside(): void {
    if (!this.mediaId || !this.network.isOnline()) return;
    const fileId = this.mediaFileId;
    void this.mediaService.getOne(this.mediaId).then(
      (media) => {
        if (fileId !== this.mediaFileId) return;
        this.media = media;
        this.mediaLoadedTick.update((v) => v + 1);
        this.applyMedia(media);
        this.queueCtl.syncSeriesQueue();
      },
      () => {},
    );
  }

  /** Switch to another episode of the open series without tearing the player down: swap the source like {@link
   *  doReloadStream} and refresh episode-scoped state. Serialised via {@link reloadingStream}. */
  private async reloadForEpisode(
    mediaFileId: number,
    mediaId: number,
    episodeId: number | undefined,
    opts: { noResumeLookup?: boolean } = {},
  ): Promise<void> {
    if (!this.engine || this.reloadingStream || mediaFileId === this.mediaFileId) return;
    this.reloadingStream = true;
    this.reloadLoadPending = true;
    this.switchingItem = true;
    this.engine.resetRecoveryGuard();
    const previousSessionId = this.playbackInfo?.sessionId;
    this.qoe.setStalled(false, { sessionId: previousSessionId, position: this.engine.currentTime });
    this.qoe.flushKeepalive(previousSessionId);
    let startTime: number | undefined;
    try {
      // Surface the loading backdrop (set to the new episode's still below)
      // over the outgoing frame and rewind the playhead UI to the start.
      this.state.reset();
      this.qoe.reset();
      this.recovery.clearEpisode();
      this.edlEnded = false;
      // Drop the outgoing episode's info so an early failure doesn't report its stale playMethod/hwAccel.
      this.playbackInfo = null;
      this.resetTrackState();

      // Native engines must be stopped before a fresh load to avoid a freeze;
      // release the outgoing file's session (other devices on it stay alive).
      if (this.isNativeEngine()) await NativePlayer.stop().catch(() => {});
      if (previousSessionId) {
        await this.streamingApi.stopSession(previousSessionId).catch(() => {});
      }

      this.mediaFileId = mediaFileId;
      this.episodeId = episodeId;
      // Same series → media is unchanged; reload it only if the id differs
      // (a queue can cross media). Refresh the title/logo when it does.
      if (mediaId && mediaId !== this.mediaId) {
        this.mediaId = mediaId;
        this.media = await this.mediaService.getOne(mediaId);
      }
      // Recompute next-item context + refresh the episode label / backdrop.
      this.mediaLoadedTick.update((v) => v + 1);
      if (this.media) this.applyMedia(this.media);
      this.queueCtl.syncSeriesQueue();

      const file = this.currentFile();
      const knownDuration = (file?.streamInfo as any)?.durationSeconds;
      if (knownDuration && knownDuration > 0) this.state.duration.set(knownDuration);

      // The new file opens on its own audio pick; the backend marks it DEFAULT.
      this.resolveAudioTarget();
      await this.planSubtitleDelivery();

      // The new file's token goes into its own playback-info call.
      await this.requireStreamToken();
      await this.negotiateAndLoad({
        start: (pi) => {
          // Skipped for a pre-roll transition: the ids stay on the main film, so it would seek a trailer.
          if (!opts.noResumeLookup) startTime = pi.startAtSeconds || undefined;
          this.pendingStartTime = startTime ?? 0;
          startTime = this.edlStartTime(startTime);
          return { url: startTime, load: startTime };
        },
        onLoaded: () => this.edl.settle(),
      });
      await this.completeEpisodeSwitchSetup();
    } catch (e: any) {
      if (this.fallBackFromRemuxOnLoadError(e, startTime ?? 0, () => this.completeEpisodeSwitchSetup())) return;
      this.state.failWith(e, { dolbyVision: this.isDolbyVisionPassthrough() });
    } finally {
      this.switchingItem = false;
      this.reloadingStream = false;
      this.qoeGraceUntil = Date.now() + 3_000;
      this.reloadLoadPending = false;
      this.state.loading.set(false);
      this.drainPendingReload();
    }
  }

  onVolumeChange(vol: number) {
    const other = this.elsewhere();
    if (other) return other.setVolume(vol);
    if (!this.engine) return;
    // Dragging sets the level and lifts a mute; state signals follow the engine's `volumechange` event.
    this.engine.volume = vol;
    if (vol > 0 && this.engine.muted) this.engine.muted = false;
  }

  onToggleMute() {
    const other = this.elsewhere();
    if (other) return other.toggleMute();
    if (!this.engine) return;
    // Toggle audible/silent, not the raw mute flag: when silent (muted or level 0) a click restores sound,
    // bumping level 0 to full so the button never looks stuck.
    const silent = this.engine.muted || this.engine.volume === 0;
    if (silent) {
      this.engine.muted = false;
      if (this.engine.volume === 0) this.engine.volume = 1;
    } else {
      this.engine.muted = true;
    }
  }

  /** Once playback starts, clear the autoplay-blocked flag and report it to remote controllers. */
  private readonly autoplayClearEffect = effect(() => {
    if (!this.state.videoStarted()) return;
    untracked(() => {
      if (!this.autoplayBlocked()) return;
      this.autoplayBlocked.set(false);
      void this.savePosition(true);
    });
  });

  /** A local pause reaches a remote controller only on the next heartbeat (up to 10s); one effect on the engine
   *  state covers every transport source. */
  private lastReportedPaused: { fileId: number; paused: boolean } | null = null;
  private readonly transportReportEffect = effect(() => {
    const paused = this.uiPaused();
    untracked(() => this.reportTransportChange(paused));
  });

  /** Flush only on a real transition, and not before the first frame: the load
   *  path moves this flag around while there is nothing worth reporting. */
  private reportTransportChange(paused: boolean): void {
    if (!this.state.videoStarted()) return;
    // Keyed by file: an episode switch dips through paused while `videoStarted` is false, so a memory carried
    // over from the previous episode must not suppress the resume report.
    const last = this.lastReportedPaused;
    if (last && last.fileId === this.mediaFileId && last.paused === paused) return;
    this.lastReportedPaused = { fileId: this.mediaFileId, paused };
    void this.savePosition(true);
  }

  /** Which track is on is decided by the auto-selection during load as much as
   *  by a click, so report the value rather than the gesture. */
  private lastReportedTracks = '';
  private readonly trackReportEffect = effect(() => {
    const casting = this.castService.isConnected();
    const audioId = casting ? this.castPlayerService.activeAudioTrackId() : this.activeAudioTrackId();
    const subtitleId = casting ? this.castPlayerService.activeSubtitleId() : this.subs.activeSubtitleId();
    const key = `${this.mediaFileId}|${audioId}|${subtitleId}`;
    untracked(() => {
      if (!this.state.videoStarted()) return;
      if (this.lastReportedTracks === key) return;
      this.lastReportedTracks = key;
      void this.savePosition(true);
    });
  });

  /** The first frame is when the resume position and the duration are finally
   *  true; the load-time heartbeat ran before any of it was known. */
  private readonly firstFrameReportEffect = effect(() => {
    if (!this.state.videoStarted()) return;
    untracked(() => {
      if (this.engine && this.session.isLocal()) {
        void this.qoe.refresh(this.engine, this.activeSessionId());
      }
      void this.savePosition(true);
    });
  });

  /** Buffering after the first frame that no seek, load or quality switch explains. */
  private readonly qoeStallEffect = effect(() => this.syncStall());

  private syncStall(): void {
    let frozenSince = this.frozenSince();
    const buffering = this.state.buffering();
    const started = this.state.videoStarted();
    untracked(() => {
      const pos = this.engine?.currentTime ?? 0;
      if (!this.wasBuffering && buffering) {
        this.bufferStartAt = Date.now();
        this.bufferStartPos = pos;
      } else if (this.wasBuffering && !buffering) {
        // Still frozen once the engine calls it over: keep one episode open until the playhead moves.
        if (
          started &&
          !this.paused() &&
          this.playheadWatch.carryOver(
            Date.now(),
            this.bufferStartAt,
            this.bufferStartPos,
            pos,
            this.engine?.positionUpdateMs,
          )
        ) {
          this.frozenSince.set(this.bufferStartAt);
          frozenSince = this.bufferStartAt;
        }
      }
      this.wasBuffering = buffering;
      const stalled = (buffering && started) || frozenSince > 0;
      this.trackStall(stalled, frozenSince || undefined);
    });
  }

  /** Playhead frozen while it should advance, even when the engine never said `buffering`. */
  private readonly frozenSince = signal(0);
  private readonly playheadWatch = new PlayheadWatch(0);
  private wasBuffering = false;
  private bufferStartAt = 0;
  private bufferStartPos = 0;
  private watchPlayhead(): void {
    const now = Date.now();
    const engine = this.engine;
    // Decided before touching the position: on Tizen it is a synchronous AVPlay call.
    const watching =
      !!engine &&
      !this.paused() &&
      !this.uiPaused() &&
      this.state.videoStarted() &&
      !this.state.loading() &&
      !this.state.seekLocked() &&
      !this.state.ended() &&
      !this.state.error() &&
      this.session.isLocal() &&
      !(typeof document !== 'undefined' && document.hidden);
    const pos = watching ? engine.currentTime : -1;
    const dur = watching ? engine.duration : 0;
    this.playheadWatch.tick(pos, watching && !(dur && pos >= dur - 0.5), now, frozenAfterMs(engine?.positionUpdateMs));
    this.frozenSince.set(this.playheadWatch.frozenSince);
  }

  private trackStall(stalled: boolean, since?: number): void {
    const at = since ?? Date.now();
    const ignored =
      this.state.seekLocked() ||
      this.reloadingStream ||
      this.reloadLoadPending ||
      this.recovery.active ||
      at < this.qoeGraceUntil ||
      at - Math.max(this.lastSeekAt, this.lastQualitySwitchAt) < 2_000;
    const position = this.engine?.currentTime ?? 0;
    const end = this.state.bufferedEnd();
    this.qoe.setStalled(stalled && !this.state.error(), {
      bufferAheadS: end > 0 && this.engine?.measuresBuffer !== false ? Math.max(0, end - position) : null,
      sessionId: this.activeSessionId(),
      position,
      ignored,
      since,
    });
  }

  private readonly qoeErrorEffect = effect(() => {
    const err = this.state.error();
    if (!err) return;
    untracked(() =>
      this.qoe.onError(this.activeSessionId(), this.engine?.currentTime ?? 0, {
        code: err.code,
        message: err.message ? this.redactSecrets(err.message) : undefined,
        category: err.source,
      }),
    );
  });

  protected onFullscreenChange(): void {
    this.fullscreen.set(!!document.fullscreenElement);
  }

  onToggleFullscreen() {
    // Desktop compositor: the visible surface is the native (SDL) window owned
    // by the addon, not this offscreen WebView, so toggle fullscreen there.
    if (this.isDesktopNative && this.engine instanceof DesktopEngine) {
      this.engine.setFullscreen(!this.engine.fullscreen);
      this.fullscreen.set(this.engine.fullscreen);
      return;
    }
    // iOS Safari rejects the Fullscreen API on arbitrary elements; only the <video> tag's
    // `webkitEnterFullscreen` works. Detect by capability, not UA, so iPadOS desktop mode still works.
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
      const el = this.shellEl()?.nativeElement ?? this.containerEl()?.nativeElement ?? document.documentElement;
      el.requestFullscreen();
    }
  }

  onTogglePip() {
    if (!this.session.isLocal()) return;
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

  /** A destination picked from the player's own list takes over the running playback at its current position. */
  async onPickDevice(row: PickerRow): Promise<void> {
    // AirPlay reroutes this very playback: nothing to hand off. Synchronous,
    // Safari only opens its picker inside the click.
    if (row.kind === 'airplay') {
      this.airPlay.showPicker();
      return;
    }
    if (row.kind === 'local') await this.session.moveTo('local');
    else await this.session.moveTo(row.kind === 'remote' ? 'remote' : 'cast', row.kind === 'cast-web' ? undefined : row.id);
  }

  /** Settles when the first launch ends (loaded or failed), so a handoff never races the engine it would unload. */
  private firstLoadSettled: Promise<void> = Promise.resolve();
  private settleFirstLoad: () => void = () => {};
  private trackSetup: Promise<void> = Promise.resolve();

  /** Moving off this device: the engine falls silent and unloads, and what the target needs is handed over. */
  private async releaseForHandoff(): Promise<LocalHandoff | null> {
    const resolveSubtitle = !this.firstLoadSetupDone;
    await this.firstLoadSettled;
    await this.trackSetup.catch(() => {});
    const engine = this.engine;
    if (!engine || !this.mediaId) return null;
    // The cast must start on the main item, never on a trailer.
    if (this.preRollActive()) {
      this.preRollRest = [];
      await this.advancePreRoll();
    }
    // The picture leaves: the phone turns freely.
    this.screen.releaseForCast();
    const snapshot = this.snapshot()!;
    await this.pausePlayback();
    engine.muted = true;
    await engine.unload();
    return {
      snapshot,
      cast: this.castStart(),
      resolveSubtitle,
      audioLanguage: this.targetAudioLanguage(),
      localSessionId: this.playbackInfo?.sessionId,
    };
  }

  /** What a handoff carries: the engine's position, the viewer's pause intent and the picks on screen. */
  private snapshot(): PlaybackSnapshot | null {
    if (!this.engine || !this.mediaId) return null;
    return {
      item: { fileId: this.mediaFileId, mediaId: this.mediaId, episodeId: this.episodeId },
      position: this.engine.currentTime,
      paused: this.pauseIntent(),
      tracks: { fileId: this.mediaFileId, audioStreamIndex: this.activeAudioStreamIndex, subtitleId: this.subs.activeSubtitleId() },
    };
  }

  /** Another output already plays: this engine pauses and mutes, whichever kind it is. */
  private stepAside(): void {
    this.screen.releaseForCast();
    void this.pausePlayback();
    if (this.engine) this.engine.muted = true;
  }

  /** What a receiver needs to describe the running media: the local picks are what it starts on. */
  private castStart(): CastStart {
    return {
      mediaFileId: this.mediaFileId,
      mediaId: this.mediaId,
      episodeId: this.episodeId,
      playbackMode: this.playbackMode(),
      subtitles: this.subs.availableSubtitles(),
      qualities: [],
      audioTracks: this.castAudioOptions(),
      activeQualityId: this.activeQualityId(),
      activeSubtitleId: this.subs.activeSubtitleId(),
      activeAudioStreamIndex: this.activeAudioStreamIndex,
      playbackId: this.qoe.playbackId,
    };
  }

  /** Resolve the `startQuality` wire value: the explicit rung id, or in 'auto' the top rung when the engine has
   *  no client-side ABR (desktop mpv). Single source for every playback-info/stream-url call. */
  private resolveStartQuality(): string | undefined {
    const active = this.activeQualityId();
    // `best` is client-only: the first negotiation goes out like auto, then adoptNegotiatedQuality names the rung.
    if (active === BEST_QUALITY_ID) return undefined;
    if (active !== 'auto') return active;
    // Still 'auto': DirectStream's playUrl carries remux=1 alone, and a
    // pinned rung here would collapse the master onto a transcoded rung.
    if (this.playbackInfo?.playMethod === 'DirectStream') return undefined;
    const supportsAbr = this.deviceProfileService.getProfile().supportsAbr ?? true;
    return supportsAbr ? undefined : this.qualityManager.topRungId();
  }

  /** The playback-info call for the current track state (burn-in pick, audio index, rung); every request goes
   *  through here. `over` swaps a field: another file (no picks sent) or the Cast profile's burn-in/rung. */
  private async negotiatePlayback(
    startAt?: number,
    over: Partial<{ fileId: number; profile: DeviceProfile; burnInId: number | null; quality: string }> = {},
    opts?: { skipErrorToast?: boolean; replaces?: string; preRollFirst?: boolean },
  ): Promise<PlaybackInfoResponse> {
    const fileId = over.fileId ?? this.mediaFileId;
    const onScreen = fileId === this.mediaFileId;
    const own = this.deviceProfileFor(fileId, !(await this.hasMuteRanges(fileId)));
    const request = {
      profile: onScreen && this.subs.needsHlsSubtitles ? { ...own, needsHlsSubtitles: true } : own,
      burnInId: onScreen ? this.subs.activeBurnInId : null,
      audioStreamIndex: onScreen ? this.activeAudioStreamIndex : undefined,
      quality: this.resolveStartQuality(),
      ...over,
    };
    return this.streamingApi.getPlaybackInfo(
      fileId,
      request.profile,
      request.burnInId ?? undefined,
      request.audioStreamIndex,
      request.quality,
      startAt,
      undefined,
      opts,
    );
  }

  private readonly muteRangesByFile = new Map<number, Promise<boolean>>();

  /** Whether the file's `.edl` mutes anything; a bitstream sink ignores volume, so the muted part must be decoded.
   *  Only asked where passthrough is on offer; an unreadable EDL counts as muted. */
  private hasMuteRanges(fileId: number): Promise<boolean> {
    if (!this.deviceProfileService.offersPassthrough()) return Promise.resolve(false);
    let known = this.muteRangesByFile.get(fileId);
    if (!known) {
      known = this.streamingApi.getEdl(fileId).then((r) => muteRangesOf(r).length > 0, () => true);
      this.muteRangesByFile.set(fileId, known);
    }
    return known;
  }

  /** What an engine must be told before every load(): its configuration is read
   *  anew on each one, so nothing carries over from the previous load. */
  private async prepareLoad(): Promise<void> {
    this.audioSwitchPending = null;
    this.configureAudioLanguage();
    if (this.engine) this.armStartPaused(this.engine);
    if (this.engine instanceof NativeEngine) {
      this.engine.setPreloadedSubtitles(await this.nativeSidecars());
    }
  }

  /** The subtitle list of the file on screen, fetched on first use. */
  private itemSubtitles(): Promise<SubtitleOption[]> {
    if (this.subtitleFetch?.fileId !== this.mediaFileId) {
      this.subtitleFetch = {
        fileId: this.mediaFileId,
        list: this.trackManager.loadSubtitles(this.mediaId, this.mediaFileId, this.streamingApi, this.media),
      };
    }
    return this.subtitleFetch.list;
  }

  /** The subtitle the item opens on, once its list and audio are known. This is the one use
   *  of the launch pick, so the item's later reloads and episode switches never see it. */
  private async autoSelectSubtitle(): Promise<void> {
    const picked = this.launchPick()?.subtitleId;
    if (this.launchPick()) this.launchTracks = null;
    await this.trackManager.autoSelectSubtitle(
      this.subs.availableSubtitles(),
      this.availableAudioTracks(),
      this.activeAudioTrackId(),
      this.mediaFileId,
      (sub) => this.subs.applySubtitle(this.subs.plainIfStyled(sub)),
      this.mediaId,
      this.targetAudioLanguage(),
      picked,
    );
  }

  /** Settles before the negotiation whether the automatic selection will pick a text
   *  subtitle this engine can't sideload, so the first load is already HLS. */
  private async planSubtitleDelivery(): Promise<void> {
    this.subs.needsHlsSubtitles = false;
    if (!this.subs.textNeedsHls()) return;
    const auto: { sub: SubtitleOption | null } = { sub: null };
    await this.trackManager.autoSelectSubtitle(
      await this.itemSubtitles(), [], null, this.mediaFileId,
      async (sub) => { auto.sub = this.subs.plainIfStyled(sub); },
      this.mediaId, this.targetAudioLanguage(), this.launchPick()?.subtitleId,
    );
    this.subs.needsHlsSubtitles = !!auto.sub && !auto.sub.burnIn;
  }

  /** Sidecar subtitles for the native MediaItem: external files in direct play (HLS ships them as renditions,
   *  so a list there would double them) and offline VTTs, in {@link subtitleOrdinal} order. */
  private async nativeSidecars(): Promise<NativeSidecarSubtitle[]> {
    if (this.isOfflinePlayback) return this.getOfflineSubtitleConfigs();
    if (this.playbackMode() !== 'direct') return [];
    return (await this.itemSubtitles())
      .filter((s) => !s.burnIn && !!s.url && s.id.startsWith('ext-'))
      .sort((a, b) => this.subs.manifestRank(a) - this.subs.manifestRank(b))
      .map((s) => ({ url: s.url, language: s.language, label: s.label, forced: !!s.forced }));
  }

  /** Drops what the outgoing item chose so the next starts clean. The engine forgets its subtitle too: engines
   *  keep their selection across load() and auto-selection never asks for Off. */
  private resetTrackState(): void {
    try { this.engine?.setTextVisibility(false); } catch {}
    if (this.audioTracksTimer) clearTimeout(this.audioTracksTimer);
    this.audioTracksTimer = null;
    this.availableAudioTracks.set([]);
    this.activeAudioTrackId.set(null);
    this.activeAudioStreamIndex = undefined;
    this.audioSwitchPending = null;
    this.subs.availableSubtitles.set([]);
    this.subs.activeSubtitleId.set(null);
    this.subs.activeBurnInId = null;
    this.subs.needsHlsSubtitles = false;
    this.subs.subtitleRequest++;
  }

  /** The target's language for engines that pre-select by it (Shaka, mpv `alang`), unless a
   *  server master marks it DEFAULT: Shaka would skip that for a 2-channel track of the language. */
  private configureAudioLanguage(): void {
    const serverMaster = !this.isOfflinePlayback && this.playbackMode() !== 'direct';
    const language = serverMaster ? undefined : this.targetAudioLanguage();
    this.engine?.configure?.({
      preferredAudioLanguage: language ? normalizeLangCode(language) : '',
    });
  }

  /** Language of the audio that will play, known from streamInfo before any
   *  engine lists a track. */
  private targetAudioLanguage(): string | undefined {
    const idx = this.activeAudioStreamIndex;
    return idx == null ? undefined : this.audioStreamInfo()[idx]?.language;
  }

  /** `startAt` for a reload: the live position, including 0; never omitted,
   *  since an omitted value falls back to the stale saved DB position. */
  private reloadStartAt(pos: number | undefined): number | undefined {
    // The clock reads 0 until the load's seek lands: carry the resume point it is headed to.
    const at = !pos && this.pendingStartTime > 0 ? this.pendingStartTime : pos;
    return at != null ? Math.floor(at) : undefined;
  }

  /** `{url, mimeType}` for the engine's `load()`, from the negotiated `pi`.
   *  `startTime` is HLS-only: the encoder starts there, and every load at a known position passes it. */
  private buildPlayUrl(opts: {
    sid?: string | null;
    startTime?: number;
  } = {}): { url: string; mimeType?: string } {
    const pi = this.playbackInfo!;
    const sid = opts.sid ?? pi.sessionId;
    const built: { url: string; mimeType?: string } = {
      url: this.streamingApi.buildPlayUrl(pi, {
        sid: sid ?? undefined,
        startAt: opts.startTime,
        startQuality: this.resolveStartQuality(),
      }),
      mimeType: pi.playMethod === 'DirectPlay' ? 'video/mp4' : undefined,
    };
    this.lastStreamUrl = built.url;
    return built;
  }

  /** Apply a freshly negotiated `pi`: playback mode, hw-accel, quality
   *  ladder/pin, crop, and markers/chapters. Shared so every reload path stays in sync. */
  private adoptPlaybackInfo(pi: PlaybackInfoResponse): void {
    this.state.playbackMode.set(playbackModeOf(pi));
    this.state.hwAccel.set(pi.hwAccel);
    this.qualityManager.buildQualityOptions(pi);
    this.qualityManager.adoptNegotiatedQuality(pi.quality);
    this.applyVideoCrop();
    this.introMarker.set(pi.markers?.intro ?? null);
    this.outroMarker.set(pi.markers?.outro ?? null);
    this.chapters.set(pi.chapters ?? []);
    this.edl.load(this.mediaFileId, pi.edl);
  }

  /** The old sid must not outlive the new open as a sibling that splits onto a cold job: the server retires
   *  it inside `playback-info` when it can, else it is stopped first. */
  private async retirePreviousSession(sid: string | undefined): Promise<{ replaces?: string }> {
    if (!sid) return {};
    if (this.authService.hasServerFeature('sessionReplaces')) return { replaces: sid };
    await this.streamingApi.stopSession(sid).catch(() => {});
    return {};
  }

  /** Mint a fresh LiveSession via `playback-info` and reload the engine at
   *  `pos` with the new sid. False when the remux fallback took the reload over. */
  private async refreshSidAndReload(
    pos: number,
    opts: { preservePause: boolean; unmute: boolean; paused?: boolean },
  ): Promise<boolean> {
    if (!this.engine || !this.mediaFileId) return true;
    try {
      await this.reloadAt(pos, { ...opts, restart: false });
      return true;
    } catch (e) {
      if (!this.fallBackFromRemuxOnLoadError(e, pos)) throw e;
      return false;
    }
  }

  /** A reload that failed after the serial stop was skipped: the old session would live until its TTL. */
  private stopUnreplaced(r: { replaces?: string }): void {
    if (r.replaces) void this.streamingApi.stopSession(r.replaces).catch(() => {});
  }

  /** The viewer's pause intent. Before the first frame `paused` still holds its initial `true`: a launch not
   *  yet started (native autoplays without `play()`), never a pause to preserve. */
  private pauseIntent(): boolean {
    return this.state.videoStarted() && this.paused();
  }

  /** Native engines autoplay on load(), so a paused user must be actively re-paused after a reload. */
  private restorePlayState(wasPaused: boolean): void {
    if (!this.engine) return;
    if (wasPaused) void this.pausePlayback();
    else this.playPlayback();
  }

  /** Set in ngOnDestroy: blocks late async reloads (sessionLost, sessionExpired, Cast resume) that would
   *  relaunch a native player in the background. */
  private destroyed = false;

  /** One-time setup after the first successful load (tracks, Cast/autoplay,
   *  intervals, seeked listener, sprites), whether the load or its copy fallback succeeded. */
  private async completePostLoadSetup(): Promise<void> {
    // A fallback can settle after ngOnDestroy; its intervals would never be cleared.
    if (this.destroyed || !this.engine) return;
    this.postLoadDone = true;
    // Tracks and subtitles load beside playback: a slow subtitle list must not delay the first frame.
    const trackSetupPromise = this.trackSetup = (async () => {
      if (this.isOfflinePlayback) {
        // Offline: load pre-downloaded subtitles from local storage (no API)
        await this.loadOfflineSubtitles();
        this.loadAudioTracks();
      } else if (!this.subs.availableSubtitles().length) {
        // The fetch started in parallel with engine.load (Shaka + native).
        this.subs.availableSubtitles.set(await this.itemSubtitles());
        this.loadAudioTracks();
      } else {
        this.loadAudioTracks();
      }
      await this.autoSelectSubtitle();
    })();
    trackSetupPromise.catch((e) => console.warn('[player] track setup failed', e));

    if ((!this.isNativeEngine() || this.isDesktopNative || this.openedPaused) && !this.loadedPaused) {
      this.engine!.play().catch(() => {
        // No user gesture on a remotely started device: the browser refuses autoplay. Reported so a controller
        // can tell why the device is paused (its own play button is refused too).
        console.warn('[player] autoplay blocked');
        this.autoplayBlocked.set(true);
        void this.savePosition(true);
      });
    } else if (this.loadedPaused) {
      // Opened paused: no pause event ends the launch the transport shows as playing.
      void this.pausePlayback();
    }

    // Hide controls after autoplay starts
    this.chrome.resetHideTimer();

    // Save position every 10s + immediately on seek
    this.saveInterval = setInterval(() => this.savePosition(), HEARTBEAT_MS);
    this.recovery.resetStallWatchdog();
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.addEventListener('seeking', this.onSeeking);
      video.addEventListener('seeked', this.onSeeked);
    }

    // Apply subtitle appearance + load thumbnail sprite metadata
    this.applySubtitleStyle();
    this.loadSpriteMetadata();

    // Update stats every second
    this.recovery.armClock();
    this.playheadInterval = setInterval(() => this.watchPlayhead(), this.isTizen ? 500 : 250);
    this.statsInterval = setInterval(() => {
      this.recovery.tickClockWatch();
      this.recovery.checkStall();
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
  }

  /** Post-load steps for an episode switch, run after its own load or its copy fallback. */
  private async completeEpisodeSwitchSetup(): Promise<void> {
    this.subs.availableSubtitles.set(await this.itemSubtitles());
    this.loadAudioTracks();
    await this.autoSelectSubtitle();

    // Refresh the seek-preview sprites for the new file.
    this.spriteAbort?.abort();
    void this.loadSpriteMetadata();

    if (!this.isNativeEngine() && !this.loadedPaused) this.engine?.play().catch(() => this.autoplayBlocked.set(true));
    // Reveal the controls across the switch so the new title/episode shows;
    // the auto-hide countdown retracts them on the usual delay.
    this.chrome.show();
  }

  /** Segment URLs bake the token at load: a failed mint must fail the load, not fall back to the 1 h access token. */
  private async requireStreamToken(): Promise<void> {
    if (!(await this.authService.ensureStreamToken(this.mediaFileId))) throw new Error('stream token unavailable');
  }

  /** Wires the two ways a live session goes bad: `sessionExpired` (a backend
   *  410) recovers immediately; `error` routes to {@link CopyFallbackController.maybeFallback}. */
  private wireErrorRecovery(engine: PlaybackEngine): void {
    // A frame on screen after a failure (a quality switch, a reload) means playback is back: the error panel goes.
    engine.on('firstFrame', () => this.state.error.set(null));
    engine.on('sessionExpired', () => {
      void this.recovery.recoverFromLostSession('session_expired');
    });
    engine.on('externalPlaybackFailed', ({ reason }) => {
      void this.onExternalPlaybackFailed(reason);
    });
    engine.on('error', (e) => {
      if (this.reloadLoadPending || this.recovery.active) {
        console.warn('[player] engine error dropped, a reload/recovery is already in flight', e);
        return;
      }
      this.copyFallback.maybeFallback(
        { source: e.source, code: e.code, message: e.message, audioCodec: e.audioCodec },
        this.engine?.currentTime || this.state.currentTime() || 0,
      );
    });
  }

  /** A receiver that can't show HDR refuses an HDR-only master: renegotiate SDR once, then show the card rather
   *  than sit on a spinner. */
  private async onExternalPlaybackFailed(reason: string): Promise<void> {
    if (this.destroyed || !this.session.isLocal()) return;
    const id = this.mediaFileId;
    const pi = this.playbackInfo;
    const trySdr = !!pi?.source?.hdrFormat && !pi.tonemapping && !this.sdrFallbackFileIds.has(id);
    if (!this.engine || !trySdr) {
      this.state.setError(this.translate.instant('player.error_airplay_unsupported'), {
        message: `AirPlay receiver stopped playback: ${reason}`,
      });
      return;
    }
    this.sdrFallbackFileIds.add(id);
    this.state.setRecovering(true);
    try {
      if (!(await this.copyFallback.waitForReloadIdle())) {
        this.state.setError(this.translate.instant('player.error_airplay_unsupported'), {
          message: 'AirPlay SDR fallback dropped: another reload is still running',
        });
        return;
      }
      this.state.setRecovering(true);
      await this.reloadStream(this.engine.currentTime, { reason: 'other' });
    } catch (e) {
      if (!this.state.error()) this.state.failWith(e);
    } finally {
      this.state.setRecovering(false);
    }
  }

  /** Delegates to {@link CopyFallbackController.fallBackFromLoadError}. */
  private fallBackFromRemuxOnLoadError(
    e: any, position: number, onRecovered?: () => Promise<void> | void,
  ): boolean {
    return this.copyFallback.fallBackFromLoadError(e, position, onRecovered);
  }

  /** Full technical dump for the error card's details block and "copy diagnostics": Shaka
   *  code/category/severity, failing variant, playback context, `data[]`. */
  errorDiagnostics(): string {
    const err = this.state.error();
    if (!err) return '';
    // playbackMode/hwAccel are meaningful only once a negotiation resolved; before that they hold the previous
    // title's values (state.reset() doesn't clear them).
    const dump = formatErrorDiagnostics(err, {
      currentTime: this.state.currentTime(),
      mode: this.playbackInfo ? this.state.playbackMode() : undefined,
      hwAccel: this.playbackInfo ? this.state.hwAccel() : undefined,
      engine: this.engineLabel(),
      url: this.lastStreamUrl,
      title: this.diagnosticsTitle(),
      device: this.diagnosticsDevice(),
      appVersion: environment.version,
    });
    return this.redactSecrets(dump);
  }

  /** Concrete playback engine behind the current session — `source: engine`
   *  alone can't tell desktop mpv from mobile native from a TV player. */
  private engineLabel(): string {
    if (this.isDesktopNative) return 'desktop-mpv';
    if (this.isTizenEngine()) return 'tizen-avplay';
    if (this.isWebOs) return 'webos';
    if (this.isNativeEngine()) return 'native';
    return 'shaka';
  }

  /** `Film` or `Series — S1:E2 - Episode` for the diagnostics header. */
  private diagnosticsTitle(): string {
    const title = this.mediaTitle();
    const episode = this.episodeTitle();
    return episode ? `${title} - ${episode}` : title;
  }

  /** Form factor + shell/platform + user agent, so a pasted report says which
   *  build and OS hit the error. */
  private diagnosticsDevice(): string {
    const platform = this.device.desktopPlatform() ?? this.device.tvPlatform();
    const label = platform
      ? `${this.device.formFactor()}/${platform}`
      : this.device.formFactor();
    return `${label} · ${navigator.userAgent}`;
  }

  /** Strip auth secrets before the diagnostics block is shown or copied: the
   *  stream URL carries a `?token=<JWT>` and requests use a Bearer header. */
  private redactSecrets(dump: string): string {
    return dump
      .replace(/([?&]token=)[^&\s]+/gi, '$1<redacted>')
      .replace(/(Bearer\s+)[\w.-]+/gi, '$1<redacted>');
  }


  /** True when the media is Dolby Vision served untouched (DirectPlay/DirectStream), so a decode failure is a
   *  DV-capability failure. Read live at error time via the PlayerStateService probe. */
  private isDolbyVisionPassthrough(): boolean {
    const method = this.playbackInfo?.playMethod;
    if (method !== 'DirectPlay' && method !== 'DirectStream') return false;
    const v = this.currentFile()?.streamInfo?.video?.[0];
    return (v?.dvProfile ?? 0) > 0;
  }

  /** GET the HLS manifest on the live sid at the playhead: a keep-alive plus prewarm that revives a GC'd
   *  session and starts ffmpeg at the resume segment (no-op if running). Skipped off HLS and offline. */
  private async prewarmCurrentStream(): Promise<void> {
    const sid = this.playbackInfo?.sessionId;
    if (!sid || this.isOfflinePlayback || this.playbackMode() === 'direct') {
      return;
    }
    // A hidden tab sees the same gap from timer throttling and nobody awaits a warm encoder; the heartbeat
    // revives it. Only a visible player earns the respawn.
    if (typeof document !== 'undefined' && document.hidden) return;
    const pos = Math.floor(
      this.engine?.currentTime || this.state.currentTime() || 0,
    );
    // Same builder as the load path, so the prewarm URL can never drift from
    // what the engine actually plays.
    const res = await fetch(this.buildPlayUrl({ sid, startTime: pos }).url, { cache: 'no-store' });
    // A bad status (401 token race, 404 GC'd session) resolves silently:
    // log it so it's not invisible when the heartbeat's own recovery masks it.
    if (!res.ok) {
      console.warn(`[player] prewarm fetch failed: ${res.status} ${res.statusText}`);
    }
  }

  /** Back on this device at `position`: reload the engine, or open it for the first time when the route started
   *  on another output. The pre-handoff LiveSession was GC'd, so mint a fresh sid rather than reuse
   *  `playbackInfo?.sessionId`, which would race the heartbeat fallback and flash a reload. */
  private async resumeLocal(s: PlaybackSnapshot): Promise<void> {
    if (this.destroyed) return;
    this.screen.applyLandscapeOnOpen();
    const adopted = this.itemAdopted;
    this.itemAdopted = false;
    const reload = !!this.engine;
    try {
      if (!reload) this.state.loading.set(true);
      if (await this.openLocal(s, reload) && reload && adopted) {
        await this.completeEpisodeSwitchSetup();
      }
    } catch (e) {
      // No retry path after a handoff: surface a terminal error instead of a silently dead player.
      if (!this.destroyed) this.state.failWith(e);
    }
  }

  /** The one way this device's engine opens: the first launch and every hand-back apply position, pause and picks here. */
  private async openLocal(
    { position, paused, tracks }: { position: number | undefined; paused: boolean; tracks: LaunchTracks | null },
    reload: boolean,
  ): Promise<boolean> {
    this.resumePaused = paused;
    try {
      if (!reload) {
        this.launchTracks = tracks;
        return await this.startLocal(position);
      }
      this.adoptTracks(tracks);
      return await this.refreshSidAndReload(position ?? 0, { preservePause: false, unmute: true, paused });
    } finally {
      this.resumePaused = false;
    }
  }

  /** The route opened while another output plays: no engine. The route's item goes there when it differs. */
  private async openOnOutput(resumeTime: number | undefined): Promise<void> {
    if (this.session.claimOpened(this.mediaFileId)) return;
    const cur = this.session.output()?.item();
    if (cur && cur.mediaId === this.mediaId && cur.episodeId === this.episodeId) return;
    await this.session.play(
      {
        fileId: this.mediaFileId,
        mediaId: this.mediaId,
        episodeId: this.episodeId,
        positionSeconds: resumeTime,
        tracks: this.launchTracks ?? undefined,
      },
      { fromStart: resumeTime === 0 },
    );
  }

  /** Set once the route took over an item the output switched to; the next local load finishes its setup. */
  private itemAdopted = false;
  private outputFollowing = false;

  /** The output moved to another item on its own (next, auto-next, party): the route follows, so saves, "this
   *  device" and the header refer to what plays. */
  private readonly followOutputEffect = effect(() => {
    const item = this.session.playing();
    untracked(() => {
      if (!this.outputFollowing || this.destroyed || !item || item.fileId === this.mediaFileId) return;
      void this.adoptOutputItem(item);
    });
  });

  private async adoptOutputItem(item: { fileId: number; mediaId: number; episodeId?: number }): Promise<void> {
    this.mediaFileId = item.fileId;
    this.episodeId = item.episodeId;
    this.playbackInfo = null;
    this.itemAdopted = true;
    this.edlEnded = false;
    this.resetTrackState();
    this.followItemInUrl(item);
    if (item.mediaId !== this.mediaId) {
      this.mediaId = item.mediaId;
      const media = await this.mediaService.getOne(item.mediaId).catch(() => null);
      if (this.destroyed || this.mediaFileId !== item.fileId) return;
      if (media) {
        this.media = media;
      }
    }
    this.mediaLoadedTick.update((v) => v + 1);
    if (this.media) this.applyMedia(this.media);
    this.queueCtl.followItem(item.mediaId, item.episodeId);
    this.queueCtl.syncSeriesQueue();
    const duration = (this.currentFile()?.streamInfo as any)?.durationSeconds;
    if (duration > 0) this.state.duration.set(duration);
    this.resolveAudioTarget();
    await this.planSubtitleDelivery();
  }

  /** Route reuse keeps the player mounted; replaceUrl keeps the old item out of history. */
  private followItemInUrl(item: { fileId: number; mediaId: number; episodeId?: number }): void {
    const { episodeId: _prev, ...rest } = this.route.snapshot.queryParams;
    const queryParams = { ...rest, mediaId: item.mediaId, ...(item.episodeId ? { episodeId: item.episodeId } : {}) };
    this.navbar.markAsBackNavigation();
    void this.router.navigate(['/watch', item.fileId], { queryParams, replaceUrl: true });
  }

  /** A reload negotiates from the player's own picks, so the ones made on the other output are moved over
   *  first, mapped to what this device can do with them. */
  private adoptTracks(tracks: LaunchTracks | null): void {
    const picked = launchPickFor(tracks, this.mediaFileId);
    if (!picked) return;
    if (picked.audioStreamIndex != null) this.activeAudioStreamIndex = picked.audioStreamIndex;
    if (picked.subtitleId === undefined) return;
    const sub = this.subs.availableSubtitles().find((s) => s.id === picked.subtitleId);
    this.subs.activeSubtitleId.set(sub?.id ?? null);
    this.subs.activeBurnInId = sub?.burnIn ? (sub.subtitleDbId ?? null) : null;
  }

  /** A reload resets the pipeline to the default rate: re-apply, then read back so an engine that refuses moves
   *  the control instead of the UI lying. */
  private restorePlaybackRate(): void {
    if (!this.engine) return;
    const wanted = this.playbackRate();
    if (wanted !== 1) this.engine.playbackRate = wanted;
    this.playbackRate.set(this.engine.playbackRate);
  }

  onSpeedChange(rate: number) {
    if (!this.engine || this.partyCtl.active()) return;
    this.engine.playbackRate = rate;
    // Read back rather than trust the request: an engine can silently keep the previous rate (e.g. Tizen AVPlay
    // outside READY/PLAYING/PAUSED).
    this.playbackRate.set(this.engine.playbackRate);
    this.edl.rearm();
  }

  /** Whether the episode reached the backend's completion threshold (within 30s of the end, or past 90%); a
   *  finished episode's "back" goes to the next one. */
  private episodeFinished(): boolean {
    // A pre-roll item reading past 90% must not send "back" to the next episode.
    if (this.preRollActive()) return false;
    const dur = this.duration();
    const pos = this.currentTime();
    return dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);
  }

  onBack() {
    this.detachLocalOutput();
    this.savePosition();
    const kind = (this.media?.type ?? this.offlineMediaType) === 'series' ? 'series' : 'movies';
    const next = this.queueCtl.nextEpisodeContext();
    const target = backTarget({
      origin: this.navHistory.originUrl,
      mediaId: this.mediaId,
      kind,
      episodeId: this.episodeId,
      landingEpisodeId: this.episodeFinished() && next ? next.episodeId : this.episodeId,
    });
    // Same handoff as a media card: the detail page paints from the record the player holds.
    const handoff = this.media && target.startsWith(`/${kind}/${this.mediaId}`) ? { media: this.media } : undefined;
    // Landing on the origin pops /watch (replaceUrl would stack a duplicate); another target replaces it. Either
    // way the NavigationEnd is marked a back-pop so /watch isn't pushed on NavbarService's history.
    this.navbar.markAsBackNavigation();
    const prev = this.navHistory.originUrl;
    void this.animateClose().then(() => {
      if (prev && prev.split('?')[0] === target.split('?')[0]) {
        history.back();
        return;
      }
      if (target === '/') {
        void this.router.navigate(['/'], { replaceUrl: true });
        return;
      }
      void this.router.navigateByUrl(target, { replaceUrl: true, state: handoff });
    });
  }

  /** Hold the navigation for the closing animation, run on the player over the app background (the destination
   *  isn't mounted yet); with a view transition available it animates over the destination instead. */
  private async animateClose(): Promise<void> {
    // A native surface renders outside the WebView, so the player owns no pixels
    // here to shrink — animating them just fades the page to black.
    if (document.documentElement.classList.contains('native-player-active')) return;
    if (viewTransitionsEnabled()) return;
    this.closing.set(true);
    await new Promise((resolve) =>
      setTimeout(resolve, PlayerComponent.closeAnimationMs),
    );
  }

  /** Retry a cold-open failure (playback never started). */
  onRetry() {
    // ponytail: route bounce instead of extracting initPlayback(); extract it if the flicker shows.
    this.state.error.set(null);
    const target = this.router.url;
    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() => this.router.navigateByUrl(target, { replaceUrl: true }));
  }

  onOpenMedia() {
    this.detachLocalOutput();
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

  /** The downloaded subtitles of the file, in manifest order like the online list. */
  private async offlineSubtitleOptions(): Promise<SubtitleOption[]> {
    const task = this.dlCache.load().find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
    const stored: { sub: OfflineSubtitle; url: string }[] = [];
    for (const sub of task?.offlineSubtitles ?? []) {
      // Native: file:// URI (must match preloaded URLs for track matching).
      // Web: blob URL (Shaka handles both).
      const url = await this.offlineStorage.getSmallFileNativeUri(sub.key);
      if (url) stored.push({ sub, url });
    }
    const rank = ({ sub }: { sub: OfflineSubtitle }) => subtitleManifestRank(sub.trackKey ?? `offline-${sub.key}`);
    return stored.sort((a, b) => rank(a) - rank(b)).map(({ sub, url }, i) => ({
      id: `offline-${sub.key}`,
      trackKey: sub.trackKey,
      // Built at playback so labels follow the current locale and settings; older
      // downloads only kept their one-line label.
      ...(sub.hearingImpaired != null
        ? this.trackManager.describeSubtitle(sub, i + 1)
        : { label: sub.label, menuHead: sub.label, menuSub: '' }),
      url,
      language: sub.language,
      languageTag: sub.languageTag,
      burnIn: false,
      forced: sub.forced ?? false,
      hearingImpaired: sub.hearingImpaired,
      providerType: sub.providerType,
    }));
  }

  /** Subtitle configs from the pre-downloaded local VTT files (for native ExoPlayer preload). */
  private async getOfflineSubtitleConfigs(): Promise<NativeSidecarSubtitle[]> {
    return (await this.offlineSubtitleOptions()).map((s) => ({
      url: s.url, language: s.language, label: s.label, forced: !!s.forced,
    }));
  }

  /** Load offline subtitles into the subtitle picker (no API calls). */
  private async loadOfflineSubtitles() {
    this.subs.availableSubtitles.set(await this.offlineSubtitleOptions());
  }

  /** Apply the user's subtitle style to a native engine, plus the bar-clearance bump (the WebKit `::cue` shift
   *  used in browser mode doesn't apply on ExoPlayer/AVPlayer). */
  private applyNativeSubtitleStyle() {
    // NativeEngine and TizenEngine both expose `setSubtitleStyle` (Shaka uses applySubtitleStyle()); duck-typed
    // to avoid importing TizenEngine just for the type.
    if (!(this.engine && typeof (this.engine as NativeEngine).setSubtitleStyle === 'function')) {
      return;
    }
    const s = this.playerSettings.get();
    const extraMargin = this.nativeSubtitleBottomBump();
    (this.engine as NativeEngine).setSubtitleStyle({
      size: s.subtitleSize,
      color: s.subtitleColor,
      shadow: s.subtitleShadow,
      background: s.subtitleBackground,
      bottomMargin: s.subtitleBottomMargin + extraMargin,
      topMargin: s.subtitleTopMargin + this.nativeSubtitleTopBump(),
    });
  }

  // ── Subtitles ──

  /** Load audio tracks: the engine's own once it lists them, else the streamInfo
   *  fallback (`si-*`), which a backend reload switches. */
  private loadAudioTracks() {
    if (!this.engine) return;

    // Wait a moment for the engine to parse the manifest/file
    if (this.audioTracksTimer) clearTimeout(this.audioTracksTimer);
    this.audioTracksTimer = setTimeout(() => {
      if (!this.engine) return;

      // Native engines populate audio tracks via audioTracksChanged event.
      // If already populated, don't overwrite.
      if (this.isNativeEngine() && this.availableAudioTracks().length > 1) return;

      const engineTracks = this.engine.getAudioTracks();
      const streams = this.audioStreamInfo();
      // An engine that folds renditions by language enumerates fewer tracks
      // than the source: keep streamInfo so none leaves the menu.
      const foldsTracks =
        !!this.deviceProfileService.getProfile().dedupesAudioByLanguage &&
        engineTracks.length < streams.length;

      if (engineTracks.length <= 1 || foldsTracks) {
        // Offline: don't show si-* fallback tracks — they can't be switched
        // via the engine. Only real engine-detected tracks are switchable.
        if (this.isOfflinePlayback || streams.length <= 1) return;
        this.adoptAudioTracks(
          streams.map((a, i) => ({ id: `si-${i}`, language: a.language ?? 'und', label: '' })),
        );
        return;
      }
      this.adoptAudioTracks(engineTracks);
    }, 2000);
  }

  /** Keep `activeAudioTrackId` pointing at a track in the list, or the selector shows no language selected;
   *  `preferred` is the engine's own active track, used when the current id is gone. */
  private reconcileActiveAudioTrack(
    tracks: { id: string }[],
    preferred?: string | null,
  ): void {
    if (!tracks.length) return;
    const current = this.activeAudioTrackId();
    if (current && tracks.some((t) => t.id === current)) return;
    this.activeAudioTrackId.set(
      (preferred && tracks.some((t) => t.id === preferred) ? preferred : null) ??
        tracks[0].id,
    );
  }

  /** A viewer's audio pick: remembered for the title, then applied. */
  onPickSubtitle(id: string | null): void {
    const o = this.elsewhere();
    if (o) o.selectSubtitle(o.availableSubtitles().find((x) => x.id === id) ?? null);
    else void this.subs.selectById(id);
  }

  async onSelectAudioTrack(trackId: string) {
    const o = this.elsewhere();
    if (o) {
      o.selectAudio(o.availableAudioTracks().find((x) => x.id === trackId) ?? null);
      return;
    }
    this.chrome.resetHideTimer();
    if (!this.isAudioPlayable(trackId)) return;
    this.trackManager.saveAudioSelection(
      trackId, this.availableAudioTracks(), this.mediaId, this.audioStreamInfo(),
    );
    await this.applyAudioTrack(trackId);
  }

  /** Makes `trackId` the target audio; a later reloadStream() sends its streamInfo index to /playback-info,
   *  otherwise the new master marks the old rendition DEFAULT=YES and the language reverts. */
  private async applyAudioTrack(trackId: string): Promise<void> {
    const request = ++this.audioRequest;
    const tracks = this.availableAudioTracks();
    const fromLabel = tracks.find((t) => t.id === this.activeAudioTrackId())?.label;
    this.activeAudioTrackId.set(trackId);
    const index = streamIndexForTrack(
      trackId, this.availableAudioTracks(), this.audioStreamInfo(), this.activeAudioStreamIndex,
    );
    if (index != null) this.activeAudioStreamIndex = index;
    this.audioSwitchPending = trackId;

    // si-* tracks are the streamInfo fallback shown before the engine surfaces switchable tracks, so only a
    // backend reload marking the new audio index DEFAULT can honour them. Offline: nothing to reload.
    if (trackId.startsWith('si-')) {
      this.audioSwitchPending = null;
      if (this.isOfflinePlayback) {
        console.warn('[player] applyAudioTrack: no backend to reload for offline playback', trackId);
        return;
      }
      const toLabel = tracks.find((t) => t.id === trackId)?.label;
      await this.reloadStream(undefined, { reason: 'audio', from: fromLabel, to: toLabel });
      return;
    }

    // Engine-level audio switch. Capture the pause intent first: a native engine reloads the stream to switch
    // track and comes back playing, which must not resume a paused user.
    const wasPaused = this.pauseIntent();
    if (this.isNativeEngine()) this.state.buffering.set(true);
    this.qoeGraceUntil = Number.MAX_SAFE_INTEGER;
    try {
      await this.engine?.selectAudioTrack(trackId);
    } finally {
      this.qoeGraceUntil = Date.now() + 3_000;
      // A newer switch owns the buffering veil and the play state now.
      if (request === this.audioRequest) {
        if (this.isNativeEngine()) this.state.buffering.set(false);
      }
    }
    if (request === this.audioRequest) this.restorePlayState(wasPaused);
  }

  protected get syncMediaId() { return this.mediaId; }
  protected get syncMediaFileId() { return this.mediaFileId; }

  protected onTapOverlay() {
    if (this.elsewhere()) return;
    if (this.subs.syncHidesControls()) this.onTogglePlay();
    else this.chrome.toggle();
  }

  // Bound DOM handlers kept as stable references so ngOnDestroy can remove
  // them — inline closures would pin this route-scoped component per session.
  private onSeeking = () => {
    this.lastSeekAt = Date.now();
  };
  private onSeeked = () => {
    this.lastSeekAt = Date.now();
    this.recovery.resetStallWatchdog();
    // Forced: a jump can't be interpolated by a controller, so waiting for the ten-second cadence left other
    // remotes on a stale position. No loop: a controller only sends on a gesture.
    void this.savePosition(true);
  };
  private spriteAbort?: AbortController;

  // ── Event handlers ──

  private onBeforeUnload = () => {
    this.qoe.setStalled(false, { sessionId: this.activeSessionId(), position: this.engine?.currentTime ?? 0 });
    this.qoe.flushKeepalive(this.activeSessionId());
    this.keepalivePositionSave();
    if (this.session.isLocal()) this.fireAndForgetStopSessions();
  };

  /** Home, input switch and standby hide the app without unloading it: bank the position, pause, and let the engine
   *  release / reacquire its decoder. */
  private onTvVisibility = () => {
    if (this.castService.isConnected()) return;
    if (document.visibilityState === 'hidden') {
      void this.savePosition(true);
      void this.pausePlayback();
      this.engine?.suspend?.();
    } else {
      this.engine?.restore?.();
    }
  };

  private onPlayerBackEvent = () => {
    // Desktop: Escape leaves the native (SDL) compositor fullscreen first, before closing controls or exiting.
    if (
      this.isDesktopNative &&
      this.engine instanceof DesktopEngine &&
      this.engine.fullscreen
    ) {
      this.engine.setFullscreen(false);
      this.fullscreen.set(false);
      return;
    }
    // TV remote Return and desktop Escape close a visible controls bar first, then exit on the next press;
    // phones and tablets exit directly (touch users dismiss controls by tapping the video).
    if ((this.device.isTv() || this.device.isDesktop()) && this.chrome.visible() && !this.elsewhere()) {
      this.chrome.hide();
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

  onCloseStats() {
    this.statsVisible.set(false);
  }

  /** The rectangle this client should remove: only when this copy is the one
   *  playing (`videoCopyStream`) - a re-encode already cut it server-side. */
  activeCropRect(): CropRect | undefined {
    if (this.isOfflinePlayback) return this.offlineCrop ?? undefined;
    return this.playbackInfo?.videoCopyStream ? this.playbackInfo.source?.crop : undefined;
  }

  /** Push the black-bar rectangle onto the active engine: mpv crops
   *  decode-side, every other engine gets {@link WebVideoCropController}'s CSS crop. */
  private applyVideoCrop(): void {
    const c = this.activeCropRect();
    if (this.isDesktopNative) {
      this.engine?.configure?.({
        videoCrop: c ? `${c.width}x${c.height}+${c.x}+${c.y}` : null,
      });
      this.desktopCropApplied.set(!!c && !!this.engine);
      return;
    }
    if (this.engine instanceof NativeEngine || this.engine instanceof TizenEngine) {
      const { width, height } = this.sourceSize();
      this.nativeCropApplied.set(this.engine.setCrop(c, width, height));
      return;
    }
    this.webCrop.refresh();
  }

  // ── WebVideoCropHost (see web-video-crop-controller.ts) ──
  cropsAtOutput(): boolean {
    return this.isDesktopNative || this.isNativeEngine();
  }
  sourceSize(): { width: number; height: number } {
    if (this.isOfflinePlayback) {
      return { width: this.offlineCrop?.sourceWidth ?? 0, height: this.offlineCrop?.sourceHeight ?? 0 };
    }
    return { width: this.playbackInfo?.source?.width ?? 0, height: this.playbackInfo?.source?.height ?? 0 };
  }
  fit(): 'contain' | 'cover' {
    return this.fillScreen() ? 'cover' : 'contain';
  }
  containerElement(): HTMLElement | undefined {
    return this.containerEl()?.nativeElement;
  }
  videoElement(): HTMLVideoElement | undefined {
    return this.videoEl()?.nativeElement;
  }

  async onSelectQualityById(id: string) {
    const o = this.elsewhere();
    if (o) {
      const pick = o.availableQualities().find((q) => q.id === id);
      if (pick) o.selectQuality(pick);
      return;
    }
    const option = this.availableQualities().find(q => q.id === id);
    if (!option) return;
    // Re-selecting the active rung is a no-op: reloadStream() would still kill + re-mint the session for no
    // change.
    if (id === this.activeQualityId()) {
      this.chrome.resetHideTimer();
      return;
    }
    const mode = this.playbackMode();
    this.lastQualitySwitchAt = Date.now();
    const from = this.availableQualities().find(q => q.id === this.activeQualityId())?.totalBitrateBps;
    this.qoe.onQualitySwitch(this.activeSessionId(), this.engine?.currentTime ?? 0, option.totalBitrateBps, from);
    // A rung below source, or any rung on the HLS ladder, re-negotiates; `original` in direct play doesn't.
    // When reloading pass engine=null so no variant is picked that the reload discards (re-applied after load).
    const willReload = mode !== 'direct' || id !== 'original';
    this.qualityManager.selectQuality(option, willReload ? null : this.engine, mode, false, true);
    if (willReload) {
      await this.reloadStream(undefined, { reason: 'quality' });
    }

    this.chrome.resetHideTimer();
  }

  // ── Private helpers ──

  /** Guards against overlapping reloads: a user switch racing a recovery (or another switch) must not run two
   *  getPlaybackInfo + load cycles at once, which races the engine and leaks a session. */
  private reloadingStream = false;
  /** True until a reload's `engine.load()` resolves: the window where an engine error is
   *  the expected teardown, unlike one raised during the post-load awaits. */
  private reloadLoadPending = false;
  /** True until ngAfterViewInit's engine.load() settles; only {@link isReloadIdle} reads it. */
  private firstLoadPending = false;
  /** Set once doReloadStream reaches a successful engine.load(), so the reloadStream catch can tell a dead
   *  surface (failure before load) from a live one. */
  private reloadReachedPlayback = false;

  /** Reload the stream (burn-in toggle, audio switch). User-initiated, so re-arm the native recovery guard and
   *  serialise against other reloads/recoveries; `at` overrides the resume anchor. */
  async reloadStream(at?: number, why: ReloadWhy = { reason: 'other' }) {
    if (!this.engine) return;
    if (this.reloadingStream) {
      // A pick made mid-reload is already persisted; replay it once the running reload settles.
      if (at === undefined) this.pendingReload = why;
      return;
    }
    this.reloadingStream = true;
    this.reloadReachedPlayback = false;
    this.engine.resetRecoveryGuard();
    // A locked seekbar holds a target the engine hasn't reached: anchor there,
    // or a mid-seek switch restarts where the user just left.
    const anchor = at ?? (this.state.seekLocked() ? this.currentTime() : this.engine.currentTime);
    this.qoe.onReload(this.activeSessionId(), anchor, why);
    try {
      await this.doReloadStream(anchor);
    } catch (e) {
      if (this.fallBackFromRemuxOnLoadError(e, anchor)) return;
      // Capacitor drops its surface before re-negotiating and desktop mpv's failure never surfaces: both need a
      // card. Tizen/Shaka/webOS self-heal via 410 -> sessionExpired; a throw after load() means video plays.
      console.error('[Player] reloadStream failed:', e);
      if (
        this.isNativeEngine() &&
        !this.isTizenEngine() &&
        !this.reloadReachedPlayback &&
        !this.destroyed &&
        !this.state.error()
      ) {
        this.state.failWith(e);
      }
      throw e;
    } finally {
      this.reloadingStream = false;
      this.qoeGraceUntil = Date.now() + 3_000;
      this.drainPendingReload();
    }
  }

  private pendingReload: ReloadWhy | null = null;
  private drainPendingReload(): void {
    const why = this.pendingReload;
    this.pendingReload = null;
    if (why && !this.destroyed) this.reloadStream(undefined, why).catch(() => {});
  }

  private async doReloadStream(currentPos: number) {
    if (!this.engine) return;
    await this.reloadAt(currentPos, { preservePause: true, unmute: false, restart: true });
  }

  /** Negotiate the stream of the current file, adopt it and load it: the part a reload and an episode switch share.
   *  `start` runs once the info is adopted and gives the position the URL and the engine start from. */
  private async negotiateAndLoad(o: {
    negotiateAt?: number;
    replace?: { replaces?: string };
    start: (pi: PlaybackInfoResponse) => { url?: number; load?: number };
    onLoaded: () => void;
  }): Promise<void> {
    const engine = this.engine!;
    const pi = (this.playbackInfo = await this.negotiatePlayback(o.negotiateAt, {}, o.replace));
    this.adoptPlaybackInfo(pi);
    // Refresh a near-expiry stream token first: it's baked into every segment URL and can't be swapped after
    // load.
    await this.requireStreamToken();
    const start = o.start(pi);
    const { url, mimeType } = this.buildPlayUrl({ startTime: start.url });
    await this.prepareLoad();
    if (this.destroyed) throw new Error('player destroyed');
    await engine.load(url, start.load, mimeType);
    this.reloadLoadPending = false;
    o.onLoaded();
    this.qualityManager.applyQualityPreferenceAfterLoad(engine, this.playbackMode());
    this.restorePlaybackRate();
  }

  /** The reload sequence around {@link negotiateAndLoad}. The URL always carries `startAt` and the load window is tracked;
   *  `restart` (user switch) also stops the native surface first, else the session is refreshed behind a live one. Throws on failure, after releasing the unreplaced session. */
  private async reloadAt(
    pos: number,
    opts: { preservePause: boolean; unmute: boolean; restart: boolean; paused?: boolean },
  ): Promise<void> {
    const engine = this.engine!;
    const at = this.reloadStartAt(pos) ?? 0;
    const endReload = this.state.beginReload();
    this.reloadLoadPending = true;
    let replace: { replaces?: string } = {};
    try {
      // Capture the viewer's play/pause intent before the teardown: a switch must not resume a paused player.
      const wasPaused = opts.paused ?? (opts.preservePause ? this.pauseIntent() : false);
      if (opts.restart && this.isNativeEngine()) await NativePlayer.stop().catch(() => {});
      // The new stream restarts at `at`: the old one must not play on through the renegotiation.
      else if (opts.restart) await engine.pause().catch(() => {});
      // Only this device's session goes; multi-device viewers on the same file stay alive.
      replace = await this.retirePreviousSession(this.playbackInfo?.sessionId);
      if (opts.unmute) engine.muted = false;
      await this.negotiateAndLoad({
        negotiateAt: at,
        replace,
        start: () => {
          engine.keepFrame = opts.restart;
          return { url: at, load: opts.restart || at > 0 ? at : undefined };
        },
        onLoaded: () => (this.reloadReachedPlayback = true),
      });
      this.restorePlayState(wasPaused);
      await this.subs.restoreSubtitle(at);
    } catch (e) {
      this.stopUnreplaced(replace);
      throw e;
    } finally {
      this.reloadLoadPending = false;
      endReload();
    }
  }

  /** The 10 s cadence loses up to 10 s of resume point when the window closes; HttpClient requests die with the page. */
  private keepalivePositionSave(): void {
    const pos = this.state.seekLocked() ? this.state.currentTime() : (this.engine?.currentTime ?? 0);
    if (!this.mediaId || !this.mediaFileId || this.preRollActive() || !this.session.isLocal() || this.switchingItem) return;
    if (!Number.isFinite(pos) || pos <= 0) return;
    const { url, init } = this.streamingApi.positionRequest(this.mediaId);
    const body = JSON.stringify({
      positionSeconds: pos,
      durationSeconds: this.engine?.duration || this.duration() || 0,
      mediaFileId: this.mediaFileId,
      episodeId: this.episodeId,
    });
    fetch(url, { ...init, body }).catch(() => {});
  }

  private fireAndForgetStopSessions() {
    // Release this device's session on exit, DirectPlay included, so its "now watching" row clears at once
    // instead of lingering until the backend idle reap.
    const sid = this.activeSessionId();
    if (!sid) return;
    const url = this.streamingApi.getStopSessionUrl(sid);
    fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  /** Get the currently active variant track. */
  private getActiveVariant(): VariantTrack | null {
    return this.engine?.getVariantTracks?.().find((t) => t.active) ?? null;
  }

  /** An episode switch is between the old stream and the new one: no save may pair either with the other's ids. */
  private switchingItem = false;

  /** Where the load in flight is seeking to; see {@link savePosition}. */
  private pendingStartTime = 0;

  /** Wall-clock ms of the last PUT to /state; dedups the saves that fire together on exit. Time-based so a
   *  paused player still beats every 10 s, which {@link LiveSessionRegistry} needs to keep the session warm. */
  private lastSaveAt = 0;

  /** `force` bypasses only the 2s throttle: after a remote command, its ack (lastCmdId) arrives in ~1s, not
   *  10s. */
  private lastForcedSaveAt = 0;
  private forcedSaveTrailing: ReturnType<typeof setTimeout> | null = null;

  /** Active audio as a streamInfo index, the one space the backend, detail header and clients agree on (a
   *  shaka-* id is engine-local). */
  private activeAudioIndex(): number | null {
    if (this.activeAudioStreamIndex != null) return this.activeAudioStreamIndex;
    const id = this.activeAudioTrackId();
    const pos = this.availableAudioTracks().findIndex((t) => t.id === id);
    return pos >= 0 ? pos : null;
  }

  /** Native ticks are not throttled in the background, unlike {@link saveInterval}: they keep the
   *  heartbeat going in PiP and with the screen off. */
  private heartbeatOnNativeTick = () => {
    if (Date.now() - this.lastSaveAt >= HEARTBEAT_MS) void this.savePosition();
  };

  private async savePosition(force = false) {
    if (force) {
      const now = Date.now();
      if (now - this.lastForcedSaveAt < FORCED_SAVE_COALESCE_MS) {
        // Coalesce, never drop: a start fires first frame, transport flip and track auto-selection within
        // milliseconds, and dropping the later ones reported the state from before playback began.
        if (this.forcedSaveTrailing) clearTimeout(this.forcedSaveTrailing);
        this.forcedSaveTrailing = setTimeout(() => {
          this.forcedSaveTrailing = null;
          void this.savePosition(true);
        }, FORCED_SAVE_COALESCE_MS);
        return;
      }
      this.lastForcedSaveAt = now;
    }
    // mediaFileId is the pre-roll's while mediaId still names the film — an
    // escaped write here would stamp the film's row with the trailer's position.
    // The remote device reports its own progress.
    if (this.session.kind() === 'remote' || this.switchingItem) return;
    if (!this.mediaId || this.preRollActive()) {
      console.warn('[player] savePosition: no active media or pre-roll in progress, skipping');
      return;
    }

    let pos: number;
    let dur: number;

    if (this.castService.isConnected()) {
      if (!this.castService.receiverPlays(this.mediaFileId) || this.castPlayerService.controlOnly()) return;
      pos = this.castService.currentTime();
      dur = this.castService.duration() || this.duration();
    } else if (this.state.seekLocked()) {
      // The engine still answers the pre-seek position until it settles, and
      // reporting that would send a controller back where it just left.
      pos = this.state.currentTime();
      dur = this.duration();
    } else if (this.engine) {
      pos = this.engine.currentTime;
      dur = this.engine.duration || this.duration();
    } else {
      console.warn('[player] savePosition: neither cast nor engine is live, skipping');
      return;
    }

    // The clock reads 0 until the load's seek to the resume point lands (the first frame can render before), so
    // report where the load is headed; any true reading retires the substitute.
    if (pos > 0) this.pendingStartTime = 0;
    else if (this.pendingStartTime > 0) pos = this.pendingStartTime;

    // Heartbeat even at position 0 (the backend refreshes the LiveSession TTL off this PUT); bail only on a
    // non-finite reading, never on 0.
    if (!Number.isFinite(pos)) return;

    const now = Date.now();
    if (!force && now - this.lastSaveAt < 2_000) return;
    this.lastSaveAt = now;
    // Cache hit until 30 min remain; later URLs (sprites, subtitles, reloads) then carry a fresh token.
    if (!this.isOfflinePlayback) void this.authService.ensureStreamToken(this.mediaFileId);

    const payload: {
      positionSeconds: number;
      durationSeconds: number;
      mediaFileId: number;
      episodeId?: number;
      sessionId?: string;
      state?: 'playing' | 'paused' | 'buffering';
      quality?: string | null;
      volume?: number;
      muted?: boolean;
      lastCmdId?: string;
      audioTrackIndex?: number | null;
      episodeLabel?: string | null;
      supportsVolume?: boolean;
      subtitleId?: string | null;
      qualities?: RemoteQualityRung[] | null;
      autoplayBlocked?: boolean;
      hasNext?: boolean;
      qoe?: QoeSample;
    } = {
      positionSeconds: pos,
      durationSeconds: dur || 0,
      mediaFileId: this.mediaFileId,
      episodeId: this.episodeId,
    };

    const sessionId = this.activeSessionId();
    if (sessionId) {
      payload.sessionId = sessionId;
      payload.state = this.state.buffering() ? 'buffering' : this.uiPaused() ? 'paused' : 'playing';
      // This device's own truth: while casting the local engine is deliberately muted (castSyncEffect), so
      // don't report it as the target's volume.
      payload.volume = this.castService.isConnected() ? this.castService.volume() : this.volume();
      payload.muted = this.castService.isConnected() ? this.castService.muted() : this.muted();
      const lastCmdId = this.remoteService.lastAppliedCmdId();
      if (lastCmdId) payload.lastCmdId = lastCmdId;
      payload.quality = this.activeQualityId() ?? null;
      // While casting, the receiver's picks are the ones in effect.
      const onReceiver = this.castService.isConnected()
        ? this.castPlayerService.selectionFor(this.mediaFileId)
        : null;
      // A controller cannot rebuild these: the rungs follow this session's
      // transcode decision.
      payload.qualities = this.availableQualities().map((q) => ({
        id: q.id,
        label: q.label,
        lowBandwidth: q.lowBandwidth,
      }));
      payload.audioTrackIndex = onReceiver ? (onReceiver.audioStreamIndex ?? null) : this.activeAudioIndex();
      payload.episodeLabel = this.episodeTitle() || null;
      payload.supportsVolume = this.engine?.supportsVolume ?? true;
      payload.subtitleId = onReceiver ? onReceiver.subtitleId : this.subs.activeSubtitleId();
      payload.autoplayBlocked = this.autoplayBlocked();
      payload.hasNext = this.queueCtl.upNext() !== null;
      // While casting, CastPlayerService's own heartbeat carries the receiver's sample; a sample after a
      // fatal error would read as playback carrying on and clear it from the verdict.
      if (this.session.isLocal() && this.engine && !this.state.error()) {
        payload.qoe = this.qoe.current(sessionId) ?? undefined;
        void this.qoe.refresh(this.engine, sessionId);
      }
    }

    // The WebView is suspended in PiP and with the screen off: the native side repeats this beat meanwhile.
    const heartbeatToken =
      this.engine instanceof NativeEngine && !this.isOfflinePlayback
        ? ((await this.authService.ensureStreamToken(this.mediaFileId)) ?? this.authService.accessToken)
        : null;
    if (this.engine instanceof NativeEngine && !this.isOfflinePlayback && heartbeatToken) {
      this.engine.setHeartbeat({
        url: this.serverConfig.resolveUrl(`/api/playback/media/${this.mediaId}/state`),
        token: heartbeatToken,
        body: { ...payload, qoe: undefined },
      });
    }

    // The offline queue persists position only; heartbeat fields are pointless once the backend session
    // expired.
    const offlinePayload = {
      mediaId: this.mediaId,
      mediaFileId: this.mediaFileId,
      episodeId: this.episodeId,
      positionSeconds: payload.positionSeconds,
      durationSeconds: payload.durationSeconds,
    };
    if (this.network.isOnline()) {
      try {
        const response = await this.streamingApi.updatePlaybackState(
          this.mediaId,
          payload,
        );
        this.qoe.flush(sessionId);
        // The backend lost our LiveSession (restart, long idle): re-issue playback-info and reload with the
        // fresh sid at the current position before the buffer drains.
        if (response?.sessionLost) {
          void this.recovery.recoverFromLostSession('session_lost');
        }
        // Auto-delete-after-watched: the moment the server marks this item
        // completed, drop its auto-managed download (no-op otherwise).
        if (response?.state?.completed) {
          void this.autoDownload.onItemCompleted(this.mediaFileId);
        }
        // Keep the device's own resume point current on the happy path: /state is uncacheable, so an offline
        // replay has only this.
        this.offlineSync.record(offlinePayload);
      } catch {
        this.offlineSync.queue(offlinePayload);
        // The beat never landed, so the session's fate is unknown: re-run the resume path once online rather
        // than wait for a 410 on the next segment.
        this.recovery.markResumeDue();
      }
    } else {
      this.offlineSync.queue(offlinePayload);
      this.recovery.markResumeDue();
    }
  }

  /** Push subtitle appearance to both renderers: CSS variables on .player-container for UITextDisplayer (DOM),
   *  and a global <style> targeting video::cue for NativeTextDisplayer (fallback / WebKit fullscreen). */
  private applySubtitleStyle() {
    const s = this.playerSettings.get();
    const fontSize = SUBTITLE_SIZE_MAP[s.subtitleSize] ?? SUBTITLE_SIZE_MAP['normal'];
    const color = SUBTITLE_COLOR_MAP[s.subtitleColor] ?? '#ffffff';
    const shadow = SUBTITLE_SHADOW_MAP[s.subtitleShadow] ?? 'none';
    const bg = SUBTITLE_BG_MAP[s.subtitleBackground] ?? 'transparent';

    // CSS variables for the UITextDisplayer path plus the WebKit cue bottom-margin lift, set on the container
    // so the variable reaches both the <video> shadow pseudo and the .shaka-text-container sibling.
    const container = this.containerEl()?.nativeElement;
    if (container) {
      container.style.setProperty('--cue-font-size', fontSize);
      container.style.setProperty('--cue-color', color);
      container.style.setProperty('--cue-bg', bg);
      container.style.setProperty('--cue-shadow', shadow);
      container.style.setProperty('--cue-bottom-margin', `${s.subtitleBottomMargin}vh`);
      container.style.setProperty('--cue-top-margin', `${s.subtitleTopMargin}vh`);
    }
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.style.setProperty('--cue-bottom-margin', `${s.subtitleBottomMargin}vh`);
    }

    // Native VTTCue path: global <style> fallback for Shaka's NativeTextDisplayer (e.g. WebKit fullscreen) and
    // non-Shaka native engines.
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
    this.spriteAbort = new AbortController();
    try {
      const url = this.streamingApi.getThumbnailMetadataUrl(this.mediaFileId);
      const res = await fetch(url, { signal: this.spriteAbort.signal });
      if (!res.ok) return;
      const meta: SpriteMetadata = await res.json();
      this.spriteMetadata.set(meta);
      const spriteUrl = this.streamingApi.getThumbnailSpriteUrl(this.mediaFileId);
      this.spriteUrl.set(spriteUrl);
      // Decode now, not on the first arrow press: the sheet is one large image, and a lazy fetch leaves the
      // first scrub previewing an empty tooltip.
      new Image().src = spriteUrl;
    } catch {
      // Sprite not available or aborted on teardown — tooltip shows time only
    }
  }

}
