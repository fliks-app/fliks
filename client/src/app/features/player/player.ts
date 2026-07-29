import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewEncapsulation,
  WritableSignal,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { StreamingApiService, PlaybackInfoResponse } from '../../core/services/api/streaming-api.service';
import { MediaService, Media } from '../../core/services/api/media.service';
import { BrowserDeviceProfileService } from '../../core/services/browser-device-profile.service';
import { SseService } from '../../core/services/sse.service';
import { AuthService } from '../../core/services/auth.service';
import { CastService } from '../../core/services/cast.service';
import { OfflineStorageService } from '../../core/services/offline-storage.service';
import { OfflinePlaybackSyncService } from '../../core/services/offline-playback-sync.service';
import { AutoDownloadService } from '../../core/services/auto-download.service';
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
import { PlaybackQueueService, QueueItem } from '../../core/services/playback-queue.service';
import { resolvePlayableFile } from '../../shared/utils/media-play.util';
import { audioChannelsLabel, formatAudioLabel, formatAudioParts, parseAudioIndex, SpriteMetadata, widthForProfile } from '../../core/utils/player.utils';
import { classifyPlaybackError, formatErrorDiagnostics, userMessageKeyFor } from '../../core/services/playback-engine/playback-error';
import { environment } from '../../../environments/environment';
import {
  PlayerSettingsService, normalizeLang,
  SUBTITLE_SIZE_MAP, SUBTITLE_COLOR_MAP, SUBTITLE_SHADOW_MAP, SUBTITLE_BG_MAP,
} from '../../core/services/player-settings.service';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { PlaybackEngine } from '../../core/services/playback-engine/playback-engine';
import { ShakaEngine } from '../../core/services/playback-engine/shaka-engine';
import { TizenEngine, isTizenAvplayAvailable } from '../../core/services/playback-engine/tizen-engine';
import { WebOsEngine } from '../../core/services/playback-engine/webos-engine';
import { NativePlayer } from '../../core/plugins/native-player.plugin';
import { NativeEngine } from '../../core/services/playback-engine/native-engine';
import { DesktopEngine } from '../../core/services/playback-engine/desktop-engine';
import { PlayerStateService } from '../../core/services/player-state.service';
import { TrackManagerService, SubtitleOption } from '../../core/services/track-manager.service';
import { QualityManagerService } from '../../core/services/quality-manager.service';
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

interface OrientationPlugin {
  lock(): Promise<void>;
  unlock(): Promise<void>;
}
const Orientation = registerPlugin<OrientationPlugin>('Orientation');

import { LucideCircleAlert, LucideInfo, LucideX } from '@lucide/angular';
import { PlayerControlsComponent } from './controls/player-controls';
import { PlayerStatsOverlayComponent, PlayerStats } from './overlay/player-stats-overlay';
import { DefaultFocusDirective } from '../../shared/directives/default-focus.directive';

/**
 * A one-shot timer that can be paused and resumed without losing the time it
 * has left. Backs the floating cues' auto-retract: the countdown freezes while
 * the controls bar is up (the user is plainly engaged) and resumes the instant
 * it hides, so a cue never vanishes out from under an interacting viewer.
 */
class PausableTimeout {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private remainingMs = 0;
  private resumedAt = 0;

  constructor(private readonly onElapsed: () => void) {}

  /** (Re)start from a full duration, discarding any prior run. */
  start(durationMs: number): void {
    this.cancel();
    this.remainingMs = durationMs;
    this.run();
  }

  /** Freeze the countdown, banking the time left. No-op unless running. */
  pause(): void {
    if (this.handle === null) return;
    clearTimeout(this.handle);
    this.handle = null;
    this.remainingMs -= Date.now() - this.resumedAt;
  }

  /** Resume a paused countdown from where it stopped. No-op unless paused. */
  resume(): void {
    if (this.handle !== null || this.remainingMs <= 0) return;
    this.run();
  }

  /** Stop and forget — the cue is gone for good. */
  cancel(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
    this.remainingMs = 0;
  }

  private run(): void {
    this.resumedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      this.remainingMs = 0;
      this.onElapsed();
    }, this.remainingMs);
  }
}

@Component({
  imports: [TranslateModule, LucideCircleAlert, LucideInfo, LucideX, PlayerControlsComponent, PlayerStatsOverlayComponent, DefaultFocusDirective],
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
    /* Hide the cursor with a transparent image, not cursor:none: on macOS the
       latter maps to NSCursor hide, whose hide/unhide stack only rebalances when
       the pointer crosses the window edge, so the OS cursor stays hidden when the
       controls re-show. An image cursor is applied via NSCursor set, so reverting
       to the default is balanced. */
    .player-container.hide-cursor {
      cursor:
        url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=')
          0 0,
        none;
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
  private readonly autoDownload = inject(AutoDownloadService);
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
  private readonly queue = inject(PlaybackQueueService);
  private readonly translate = inject(TranslateService);
  private readonly title = inject(Title);

  /** Set the browser tab title from the loaded media. The player route lives
   *  outside the main layout, so the layout's title effect doesn't run here —
   *  without this the tab keeps whichever title the previous page set (e.g.
   *  "Accueil" when launched from the home continue-watching row). Keep that
   *  previous title until the media name resolves so the tab doesn't flicker
   *  through a bare app name in between. */
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

  /** Reset the singleton PlayerStateService synchronously at field-init
   *  time so that effects declared further down (e.g. `autoHideOnPlay`)
   *  don't see lingering `videoStarted=true` / `paused=false` from the
   *  previous session. `state.reset()` is also called in
   *  `ngAfterViewInit` but that happens after the first effect pass. */
  private readonly _stateReset = (this.state.reset(), null);

  /** Register the live DV-passthrough probe once. Read at error time, so it
   *  reflects the current play method even after a mid-session quality switch.
   *  `reset()` (called again on episode reload) must not clear it, hence a
   *  one-shot registration here rather than a per-load sync. */
  private readonly _dvProbe = (
    this.state.setDolbyVisionProbe(() => this.isDolbyVisionPassthrough()),
    null
  );

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('videoElement');
  private readonly containerEl = viewChild<ElementRef<HTMLDivElement>>('playerContainer');
  private readonly controls = viewChild(PlayerControlsComponent);

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
  /** LG webOS TV. Plays through the native `<video>` media pipeline
   *  (HW HEVC/AV1, Dolby, HDR, native HLS) — a regular in-WebView element,
   *  so it groups with the Shaka UX, not the transparent-plane native one. */
  readonly isWebOs = this.device.tvPlatform() === 'webos';
  /** Native desktop shell (Electron + embedded mpv). Plays through the
   *  DesktopEngine — same transparent-overlay UX as the Capacitor native
   *  engine, with mpv behind the UI instead of ExoPlayer/AVPlayer. */
  readonly isDesktopNative = this.device.desktopPlatform() === 'electron';

  /** Template binding — true when using native (ExoPlayer/AVPlayer) engine. */
  get nativeEngine(): boolean {
    return this.isNativeEngine();
  }

  private saveInterval: ReturnType<typeof setInterval> | null = null;
  private readonly skipIntroCue = new PausableTimeout(() => this.skipIntroVisible.set(false));
  private readonly nextEpisodeCue = new PausableTimeout(() => this.nextEpisodeVisible.set(false));
  /** True while the user is actively dragging / scrubbing the seekbar. */
  private readonly seekDragging = signal(false);
  private statsInterval: ReturnType<typeof setInterval> | null = null;
  private subtitleStyleEl: HTMLStyleElement | null = null;
  /** Stall watchdog: last position we saw the playhead at, and when. If the
   *  playhead doesn't advance for {@link stallTimeoutMs} while the player is
   *  meant to be playing (a silent transcode death or a wedged buffer), we
   *  treat it like a lost session and reload at the current position. */
  private lastProgressPos = 0;
  private lastProgressAt = 0;
  private readonly stallTimeoutMs = 15_000;
  // A backward seek can trigger a 10-30s backend respawn (awaitSeekUnlock's
  // ceiling) with a frozen-but-healthy playhead; widen the window right after.
  private lastSeekAt = 0;
  private readonly seekStallGraceMs = 32_000;
  // Desktop mpv far-seek → reload thresholds: forward slack above mpv's cache
  // end, and the backward window still served from its back-cache. A seek
  // outside this band reloads at the offset instead of seeking in place.
  private readonly desktopSeekCacheSlackS = 1;
  private readonly desktopSeekBackWindowS = 15;

  // ── Template-facing signal aliases (delegate to services) ──
  readonly loading = this.state.loading;
  readonly videoStarted = this.state.videoStarted;
  readonly error = this.state.error;
  /** Transient "copied ✓" feedback for the error card's copy button. */
  readonly errorCopied = signal(false);
  readonly paused = this.state.paused;
  readonly currentTime = this.state.currentTime;
  readonly duration = this.state.duration;
  readonly volume = this.state.volume;
  readonly muted = this.state.muted;
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
      return res
        ? this.translate.instant('player.auto_resolution', { res })
        : this.translate.instant('player.auto');
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
  readonly canLockOrientation = Capacitor.getPlatform() === 'ios';
  readonly orientationLocked = signal(false);
  private readonly isLandscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);
  readonly statsVisible = signal(false);
  readonly fillScreen = signal(false);
  private readonly statsRefreshTick = signal(0);
  readonly subtitlePickerOpen = signal(false);
  readonly qualityPickerOpen = signal(false);
  /** True when any panel inside <app-player-controls> (desktop dropdown or
   *  mobile bottom sheet) is open — pins the controls open. */
  private readonly controlsPanelOpen = signal(false);

  /** Bumped on any interaction that should restart the hide countdown; the
   *  auto-hide effect re-reads it to re-arm. */
  private readonly controlsActivity = signal(0);
  /** Reasons the controls stay pinned open (never auto-hide): playback paused
   *  or buffering, an open picker / panel, or an active seekbar drag. Reactive
   *  so the moment a transient pin clears the auto-hide countdown restarts. */
  private readonly keepControlsUp = computed(
    () =>
      this.paused() ||
      this.buffering() ||
      this.seekDragging() ||
      this.subtitlePickerOpen() ||
      this.qualityPickerOpen() ||
      this.controlsPanelOpen(),
  );
  /** Single owner of the auto-hide countdown. Arms only while the bar is
   *  visible and unpinned; a change in the pin state or an activity bump
   *  re-runs it and re-arms. When a transient pin (buffering, a heavy quality
   *  switch, a drag) clears, the countdown restarts on its own — the bar can't
   *  get stuck open behind a timer that already fired while pinned. */
  private readonly autoHideEffect = effect(onCleanup => {
    if (!this.controlsVisible() || this.keepControlsUp()) return;
    this.controlsActivity();
    const delay = this.device.isTv() ? 5000 : 3000;
    const id = setTimeout(() => this.hideControls(), delay);
    onCleanup(() => clearTimeout(id));
  });

  // ── Skip-intro state ──
  /** Episode-level intro marker received in playback-info (null for movies / no marker). */
  readonly introMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Outro / end-credits marker — drives the "Épisode suivant" floating button. */
  readonly outroMarker = signal<{ startSeconds: number; endSeconds: number } | null>(null);
  /** Embedded chapters from playback-info (MKV/MP4). */
  readonly chapters = signal<{ startSeconds: number; endSeconds: number; title?: string }[]>([]);
  /** Set after a manual seek to suppress auto-skip for a short window. */
  private autoSkipSuppressedUntil = 0;
  /** Timestamp of the last processed play/pause toggle — coalesces rapid
   *  taps so a burst can't interleave a play()/pause() with an in-flight
   *  MSE append and drift A/V. */
  private lastTogglePlayAt = 0;
  /** Coalesce window for play/pause toggles. Sized to bridge an MSE append,
   *  not human double-tap cadence. */
  private readonly togglePlayCoalesceMs = 250;
  /** Tracks last episodeId we auto-skipped for to ensure we only auto-skip once per session. */
  private autoSkipFiredForEpisode: number | null = null;
  readonly spriteUrl = signal<string | null>(null);
  readonly spriteMetadata = signal<SpriteMetadata | null>(null);
  readonly activeSubtitleId = signal<string | null>(null);
  readonly activeAudioTrackId = signal<string | null>(null);
  readonly availableAudioTracks = signal<{ id: string; label: string; language: string; menuHead?: string; menuSub?: string }[]>([]);
  readonly availableSubtitles = signal<SubtitleOption[]>([]);

  /** Audio tracks from streamInfo for the Cast remote */
  readonly castAudioOptions = computed<CastAudioOption[]>(() => {
    this.mediaLoadedTick(); // recompute once this.media is populated on load
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

    // The same user can watch the same file on several devices at once —
    // only the targeted live session should react.
    if (cmd.sessionId) {
      const sid = this.activeSessionId();
      if (!sid || cmd.sessionId !== sid) return;
    }

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
      // After an in-place item switch we deliberately kept the controls up to
      // show the new title; when its first frame plays, don't snap them away —
      // start the normal auto-hide countdown instead so they linger briefly.
      if (untracked(() => this.revealAcrossSwitch)) {
        this.revealAcrossSwitch = false;
        this.resetHideTimer();
        return;
      }
      this.controlsVisible.set(false);
    }
  });
  /** One-shot: keep the controls visible across the next play-start (set on an
   *  item switch), letting the auto-hide timer retract them rather than the
   *  first-frame effect snapping them off. */
  private revealAcrossSwitch = false;

  /** Re-apply native subtitle style on controls show/hide so the bottom-margin
      bump kicks in. Browser playback uses CSS instead — see styles below. */
  private readonly subtitleControlsMarginEffect = effect(() => {
    this.controlsVisible();
    // webOS drives the same DOM subtitle overlay as the native engines but
    // reports isNativeEngine=false (it keeps the Shaka UX), so it needs an
    // explicit branch — otherwise the margin stays pinned at its load-time
    // value (controls visible → offset) and never settles flush on hide.
    if ((this.isNativeEngine() || this.isWebOs) && this.engine) {
      this.applyNativeSubtitleStyle();
    }
  });

  /** Push appearance to the active renderer whenever the settings change, so the
      in-player subtitle appearance panel lands on the cue without a reload.
      Untracked: the appliers also read controlsVisible(), whose margin bump the
      effect above already owns — tracking it here would re-style on every toggle. */
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
  private episodeId: number | undefined;
  private media: Media | null = null;
  /** Bumped whenever {@link media} is (re)assigned so reactive computeds re-run. */
  private readonly mediaLoadedTick = signal(0);
  private activeBurnInId: number | null = null;
  private activeAudioStreamIndex: number | undefined;

  readonly mediaTitle = signal('');
  /** Clearlogo for the playing media, shown in the player's top-left overlay
   *  in place of the title text. */
  readonly mediaLogoUrl = signal<string | null>(null);
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

  /** Last URL handed to the engine's load(), surfaced (token-redacted) in the
   *  error diagnostics so a failed open shows which endpoint/format was tried. */
  private lastStreamUrl = '';

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

    // Read signals so Angular tracks them as dependencies. NB: currentTime()
    // is deliberately NOT read here — it ticks ~4Hz and nothing below uses it,
    // so the stats panel refreshes off statsRefreshTick (1Hz) instead.
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

    // Video re-encodes on any pinned rung below the source. Audio is decided
    // independently by the backend — a lower video rung still copies a
    // supported audio track (e.g. AC3 5.1) verbatim — so reflect the backend's
    // audioCopyStream, not the video rung. Forcing it off the rung mislabelled a
    // copied AC3 stream as an AAC transcode.
    const isTranscodeQuality = !['auto', 'original'].includes(_quality);
    const effectiveVideoCopy = isTranscodeQuality ? false : (pi?.videoCopyStream ?? true);
    const effectiveAudioCopy = pi?.audioCopyStream ?? true;
    // Per-track audio decision for the ACTIVE track. Multi-audio renditions
    // switch client-side, so the default track's copy/reason (top-level
    // audioCopyStream / transcodeReasons) is wrong for any other track.
    // availableAudioTracks() is in streamInfo.audio order (the i-th track maps
    // to streamInfo.audio[i]), so the selected track's position is its backend
    // audioTracks index. Reading both signals keeps this computed reactive to
    // a track switch (engine-level shaka-* switches included — they never
    // refetch playback-info).
    const _activeAudioTrackId = this.activeAudioTrackId();
    const _activeAudioPos = this.availableAudioTracks().findIndex(
      (t) => t.id === _activeAudioTrackId,
    );
    const _activeAudioIndex =
      _activeAudioPos >= 0 ? _activeAudioPos : (this.activeAudioStreamIndex ?? 0);
    const activeAudioPlan = pi?.audioTracks?.find(
      (t) => t.index === _activeAudioIndex,
    );
    const activeAudioCopy = activeAudioPlan?.copy ?? effectiveAudioCopy;

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
    // The header describes the SOURCE file (resolution + HDR + codec), matching
    // the panel's `source → output` convention: the "→ Transcodage" line below
    // carries the output codec/HW and the downscale target. Source dimensions
    // keep the header stable across pinned-quality and ABR variant switches.
    const active = this.getActiveVariant();
    const urlMatch = active?.originalVideoId?.match(/\/(\d+p)\//);
    const selectedQualityOpt = this.qualityManager
      .availableQualities()
      .find((q) => q.id === _quality);
    const resLabel = this.qualityManager.resolutionLabel(
      src?.width,
      src?.height,
    );
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
    // A pinned rung carries its own authoritative target bitrate from the
    // backend — use it first so eco / -hdr rungs report their real bitrate
    // instead of falling back to the variant/remux bandwidth (which left an
    // eco selection showing the full ~9.7 Mbps).
    if (
      _quality !== 'auto' &&
      _quality !== 'original' &&
      validBps(selectedQualityOpt?.totalBitrateBps)
    ) {
      serverStreamTotalBps = selectedQualityOpt!.totalBitrateBps;
    } else if (selectedRateEntry) {
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
      videoPlaybackMode = this.translate.instant('player.stats_direct_playback');
    } else {
      const hwLabel: Record<string, string> = { qsv: 'QSV', vaapi: 'VAAPI', nvenc: 'NVENC', videotoolbox: 'Apple VT', none: 'CPU' };
      const parts = [hwLabel[hw] ?? hw.toUpperCase()];
      if (pi?.outputVideoCodec) parts.push(pi.outputVideoCodec.toUpperCase());
      // HDR survives the transcode only when the source is HDR and we're not
      // tonemapping to SDR — surface the format (HDR10 / HLG) that's emitted.
      if (src?.hdrFormat && !pi?.tonemapping) parts.push(src.hdrFormat);
      videoPlaybackMode = this.translate.instant('player.stats_transcoding', { hw: parts.join(' ') });
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
      vaapi: 'VAAPI',
      opencl: 'OpenCL',
      qsv: 'vpp_qsv',
      videotoolbox: 'VideoToolbox',
      cpu: 'CPU',
    };
    // The opencl and CPU paths run a tunable curve (tonemap_opencl / tonemap),
    // surfaced in parentheses; the vpp_qsv / VAAPI LUTs carry no curve.
    const curve = pi?.tonemapCurve
      ? ` (${pi.tonemapCurve.charAt(0).toUpperCase()}${pi.tonemapCurve.slice(1)})`
      : '';
    const tonemapAlgoLabel = pi?.tonemapAlgo
      ? `${tonemapLabel[pi.tonemapAlgo] ?? pi.tonemapAlgo}${curve}`
      : '';
    const tonemapping =
      pi?.tonemapping && tonemapAlgoLabel
        ? tonemapAlgoLabel
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
    // Translate each flag to a human label (e.g. VideoQualityReduced → "Bitrate
    // réduit (qualité choisie)") so the overlay explains bitrate/quality-driven
    // transcodes, not just raw codes. Unknown flags fall back to the raw token.
    const reasonLabel = (flag: string) => {
      const key = `player.transcode_reason.${flag}`;
      const label = this.translate.instant(key, { codec: codecName });
      return label === key ? flag : label;
    };
    const videoTranscodeReasons = effectiveVideoCopy
      ? []
      : allFlags
          .filter((f) => f.startsWith('Video') || f === 'SubtitleBurnIn')
          .map(reasonLabel);
    // Reason for the ACTIVE track: prefer its per-track plan (correct after a
    // client-side switch); fall back to the default-track flags when the
    // backend didn't send per-track plans (older server).
    const audioTranscodeReasons = activeAudioPlan
      ? activeAudioPlan.reasonFlags.map(reasonLabel)
      : effectiveAudioCopy
        ? []
        : allFlags.filter((f) => f.startsWith('Audio')).map(reasonLabel);

    // --- Audio ---
    // Derive from the SELECTED track, not the source's primary stream, so the
    // line follows a language switch. `activeAudioTrackId()` is read so this
    // computed re-runs when the user changes audio track.
    const _audioTrackId = this.activeAudioTrackId();
    const selectedAudio = this.availableAudioTracks().find(
      (t) => t.id === _audioTrackId,
    );
    // Show the audio NAME exactly as the track selector renders it:
    // selectedAudio.label is built by formatAudioLabel, which localizes the
    // language and falls back to "Piste audio N" for untagged tracks instead of
    // a raw "Und". Fall back to formatAudioLabel on the source's primary stream
    // when no track is selected yet (tracks not populated).
    const audioLabel =
      selectedAudio?.label ??
      formatAudioLabel(
        {
          language: src?.audioLanguage,
          codec: src?.audioCodec,
          channels: src?.audioChannels,
        },
        this.translate,
        1,
      );

    let audioStreamBitrate = '';
    if (selectedRateEntry && validBps(selectedRateEntry.audioBitrateBps)) {
      audioStreamBitrate = formatBitrateBps(selectedRateEntry.audioBitrateBps);
    } else if (validBps(sourceA)) {
      audioStreamBitrate = formatBitrateBps(sourceA);
    } else {
      const trackAbw = activeVariant?.audioBandwidth;
      if (validBps(trackAbw)) {
        audioStreamBitrate = formatBitrateBps(trackAbw);
      }
    }

    const audioDetailLine = src?.audioSampleRate ? `${src.audioSampleRate} Hz` : '?';

    let audioPlaybackMode: string;
    if (activeAudioCopy) {
      audioPlaybackMode = this.translate.instant('player.stats_direct_playback');
    } else {
      // Show the TARGET codec + channel layout (e.g. "OPUS - 5.1") so a downmix
      // is visible. `outputChannels` comes from the active track's plan.
      const outCodec = (
        activeAudioPlan?.outputCodec ?? pi?.outputAudioCodec ?? 'aac'
      ).toUpperCase();
      const outLayout = audioChannelsLabel(activeAudioPlan?.outputChannels);
      const codecLabel = outLayout ? `${outCodec} - ${outLayout}` : outCodec;
      audioPlaybackMode = this.translate.instant('player.stats_transcode_audio', { codec: codecLabel });
    }

    return {
      container: src?.container ?? '?',
      containerBitrate,
      outputFormat,
      outputFps,
      directPlay: pi?.playMethod === 'DirectPlay',
      videoLabel,
      videoStreamBitrate,
      videoProfileLine,
      videoPlaybackMode,
      crop: cropLine,
      tonemapping,
      videoTranscodeReasons,
      // Engine stats can read NaN before a quality switch settles; show 0.
      droppedFrames: Number.isFinite(engineStats?.droppedFrames)
        ? engineStats!.droppedFrames
        : 0,
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

    // A playlist launch registers the queue before navigating and passes its id.
    // Consume it only when it matches; any other entry point drops the queue
    // (a series queue is rebuilt from the media once it loads — see
    // syncSeriesQueue — so we never inherit a stale "up next" here).
    const playlistId = qp['playlistId'] ? +qp['playlistId'] : undefined;
    if (
      playlistId &&
      this.queue.source() === 'playlist' &&
      this.queue.sourceId() === playlistId
    ) {
      this.queue.syncTo(this.mediaId, this.episodeId);
    } else {
      this.queue.clear();
    }

    // Subtitle loading promise — started early for Shaka path, resolved later
    let subsPromise: Promise<any[]> | null = null;

    try {
      // Only use offline playback if explicitly requested via query param
      let offlineCheck: string | null = null;
      if (qp['offline'] === '1') {
        offlineCheck = await this.offlineStorage.getLocalUrl(`download-${this.mediaFileId}`).catch(() => null);
        if (!offlineCheck) {
          this.state.setError(this.translate.instant('player.offline_not_found'), {
            source: 'session',
          });
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
      const prewarmQuality = this.resolveStartQuality();
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
      // Mint the long-lived stream JWT in parallel with media/state/playback-info
      // load instead of serially before engine init — it's on the time-to-first-
      // frame critical path. Awaited just before the manifest/Bearer headers are
      // built (below).
      const streamTokenPromise = this.isOfflinePlayback
        ? null
        : this.authService.ensureStreamToken();

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
        this.mediaLogoUrl.set(media.logoUrl ?? null);
        if (media.fanartUrl) this.fanartUrl.set(this.serverConfig.resolveUrl(media.fanartUrl));

        const file = media.files?.find((f: any) => f.id === this.mediaFileId);
        this.applyEpisodeMetadata();
        this.syncSeriesQueue();

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
        this.lastStreamUrl = offlineCheck ?? '';

        if (this.isDesktopNative) {
          // Desktop: the original container lives on disk; mpv plays it back
          // offline (file://) with full codec coverage + embedded tracks.
          await this.createDesktopEngine();
          await this.engine!.load(offlineCheck!, startTime);
          await this.loadOfflineSubtitles();
        } else if (this.isNative) {
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
        if (streamTokenPromise) await streamTokenPromise;

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
        if (this.isTizen || this.isWebOs) {
          // Both TV pipelines (Samsung AVPlay, LG native <video>) share the
          // same shape: a native HW decoder with a DOM subtitle overlay and
          // the streamInfo audio fallback — no Shaka/MSE. They differ only in
          // the engine instance.
          if (this.isWebOs) {
            await this.createWebOsEngine();
          } else {
            await this.createTizenEngine();
          }
          this.applyNativeSubtitleStyle();

          // Subtitle fetch in parallel with engine load — AVPlay's
          // `setExternalSubtitlePath` waits for the player to be in
          // READY/PLAYING state, so we load(...) first, then attach
          // the active subtitle after prepareAsync resolves.
          const tvSubsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          // Auth rides in the URL query (?token=); the Bearer header is for
          // AVPlay/ExoPlayer only — the webOS <video> ignores it.
          const token =
            this.authService.streamToken() ?? this.authService.accessToken;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

          const { url: tizenUrl, mimeType: tizenMimeType } = this.buildPlayUrl({
            startTime,
          });
          await this.engine!.load(tizenUrl, startTime, tizenMimeType, headers);

          // Subtitles loaded — expose to the picker. The full auto-pick path
          // (remembered selection, language match, forced subs) runs once for
          // all engines further down via the shared `autoSelectSubtitle`, so we
          // don't pre-select here (that earlier pass was a redundant, less
          // complete duplicate — it skipped visibility / burn-in handling).
          const subs = await tvSubsPromise;
          this.availableSubtitles.set(subs);
        } else if (this.isDesktopNative || this.isNative) {
          // Native player path (Electron+mpv on desktop, ExoPlayer/AVPlayer on
          // Capacitor mobile). Subtitles arrive as HLS SUBTITLES renditions in
          // the master playlist, so the player doesn't depend on this fetch.
          // Run it in parallel and resolve it after load() (like the Shaka path
          // below) — awaiting it before load() only adds a network round-trip
          // to the time-to-first-frame critical path.
          subsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          if (this.isDesktopNative) await this.createDesktopEngine();
          else await this.createNativeEngine();

          this.applyNativeSubtitleStyle();

          // Desktop mpv: pass the preferred audio language so mpv auto-selects the
          // right rendition on load AND keeps it across seeks/reloads, instead of
          // reverting to the manifest's default track (which may be a different
          // language). Same source as the Shaka path's preferredAudioLanguage.
          if (this.isDesktopNative) {
            const audioCfg = this.playerSettings.get();
            let preferredAudioLang: string | undefined;
            if (audioCfg.rememberAudioSelections && this.mediaId) {
              preferredAudioLang =
                this.playerSettings.getRememberedAudioTrack(this.mediaId)?.split(':')[0] ?? undefined;
            }
            if (!preferredAudioLang && !audioCfg.useDefaultAudioStream) {
              preferredAudioLang = audioCfg.preferredAudioLanguage || undefined;
            }
            if (preferredAudioLang) {
              this.engine!.configure({ preferredAudioLanguage: preferredAudioLang });
            }
          }

          // Capacitor native players preload sidecar subs into the MediaItem for
          // direct play; HLS modes and the desktop mpv engine handle subs themselves.
          if (this.engine instanceof NativeEngine) {
            const ext =
              mode === 'direct'
                ? (await subsPromise)
                    .filter((s) => !s.burnIn && !!s.url && s.id.startsWith('ext-'))
                    .map((s) => ({ url: s.url, language: s.language, label: s.label }))
                : [];
            this.engine.setPreloadedSubtitles(ext);
          }

          const token =
            this.authService.streamToken() ?? this.authService.accessToken;
          const headers = token ? { Authorization: `Bearer ${token}` } : undefined;

          // HLS transcode/remux — apply quality constraint before load to
          // stop ExoPlayer from picking 4K on a phone (slow transcode →
          // A/V desync). `auto`: no constraint, ExoPlayer's ABR picks
          // adaptively. `original`: pin to source dimensions so ABR
          // can't downgrade (the user explicitly forced top quality).
          // Specific rung: pin to that rung's width/height.
          if (mode !== 'direct') {
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
          }
          const { url: nativeUrl, mimeType: nativeMimeType } = this.buildPlayUrl({
            startTime,
          });
          // Left the view during setup: stop the engine, don't start playback.
          if (this.destroyed) {
            await this.engine?.destroy().catch(() => {});
            this.engine = null;
            return;
          }
          await this.engine!.load(nativeUrl, startTime, nativeMimeType, headers);
        } else {
          await this.createShakaEngine();

          // Start subtitle loading in parallel with engine.load (Shaka doesn't need them upfront)
          subsPromise = this.trackManager.loadSubtitles(
            this.mediaId, this.mediaFileId, this.streamingApi, this.media,
          );

          if (mode !== 'direct') {
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
              // Strip any ":n" ordinal — Shaka pre-picks the variant by
              // language; autoSelectAudioTrack corrects to the Nth post-load.
              preferredLang =
                this.playerSettings.getRememberedAudioTrack(this.mediaId)?.split(':')[0] ??
                undefined;
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
          }

          // `buildPlayUrl` threads `startTime` into HLS URLs so the
          // backend pre-spawns FFmpeg at the right offset + applies the
          // quality-change grace period; direct play gets the explicit
          // `video/mp4` mimeType for Shaka.
          const { url: shakaUrl, mimeType: shakaMimeType } = this.buildPlayUrl({
            startTime,
          });
          await this.engine!.load(shakaUrl, startTime, shakaMimeType);
        }
      }

      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, this.playbackMode());

      // Load tracks (skip subtitle loading if already preloaded for native engine)
      if (this.isOfflinePlayback) {
        // Offline: load pre-downloaded subtitles from local storage (no API)
        await this.loadOfflineSubtitles();
        this.loadAudioTracks();
      } else if (!this.availableSubtitles().length) {
        // subsPromise was started in parallel with engine.load (Shaka + native);
        // resolve it here, falling back to a direct fetch if none was started.
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
      this.resetStallWatchdog();
      const video = this.videoEl()?.nativeElement;
      if (video) video.addEventListener('seeked', this.onSeeked);

      // Apply subtitle appearance + load thumbnail sprite metadata
      this.applySubtitleStyle();
      this.loadSpriteMetadata();

      // Update stats every second
      this.statsInterval = setInterval(() => {
        this.checkStall();
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
      // Classify the caught error (HttpErrorResponse = a failed playback-info
      // request, an object with a Shaka category, or an engine failure) so a
      // transport fault is never mislabelled as an mpv/engine error.
      const { source, code } = classifyPlaybackError(e);
      const userMessage = this.translate.instant(
        userMessageKeyFor({
          source,
          code,
          category: e?.category,
          dolbyVision: this.isDolbyVisionPassthrough(),
        }),
      );
      this.state.setError(userMessage, {
        source,
        code,
        category: e?.category,
        severity: e?.severity,
        data: e?.data,
        message: msg,
      });
      // TV / Tizen engine path: the AVPlay <object> + the hidden <video>
      // both stay parked on top of the error overlay if the engine dies
      // during load(). Force the player UI back into a visible-DOM state
      // so the user can read what blew up instead of staring at the
      // pre-paint bg-base-200 plane.
      if ((this.isTizenEngine() || this.isDesktopNative || this.isNativeEngine()) && this.engine) {
        document.documentElement.classList.remove('native-player-active');
        const video = this.videoEl()?.nativeElement;
        if (video) video.style.display = '';
        try {
          await this.engine.destroy();
        } catch {
          /* engine state may already be torn down — fine */
        }
        this.engine = null;
        this.isTizenEngine.set(false);
        this.isNativeEngine.set(false);
      }
      // Surface a toast on top of everything — fixed z-[9999], rendered
      // by the always-mounted <app-toast-container>, so it survives even
      // when the player-container itself isn't laying out correctly.
      try {
        this.toast.error(userMessage);
      } catch {
        /* toast service may not be ready during early init — ignore */
      }
    } finally {
      this.state.loading.set(false);
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', this.onKeyDown);

    // Best-effort cleanup on page unload. `pagehide` is added alongside
    // `beforeunload` because iOS Safari/WebView frequently skips `beforeunload`
    // (bfcache, app backgrounding) — `pagehide` fires reliably there, so the
    // ffmpeg session is released instead of lingering until its idle GC.
    window.addEventListener('beforeunload', this.onBeforeUnload);
    window.addEventListener('pagehide', this.onBeforeUnload);

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
    this.destroyed = true;
    this.savePosition();
    if (!this.castService.isConnected()) {
      // keepalive fetch (not HttpClient) so the stop survives if this destroy
      // coincides with a page unload / app background.
      this.fireAndForgetStopSessions();
    }
    if (this.engine) {
      if (this.isNativeEngine()) {
        document.documentElement.classList.remove('native-player-active');
      }
      this.engine.destroy().catch(() => {});
      // Drop the reference so any late async (recovery / cast resume) can't
      // reload a torn-down engine and relaunch playback in the background.
      this.engine = null;
    }
    this.removeSubtitleStyle();
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.removeEventListener('seeked', this.onSeeked);
    }
    this.spriteAbort?.abort();
    if (this.saveInterval) clearInterval(this.saveInterval);
    this.skipIntroCue.cancel();
    this.nextEpisodeCue.cancel();
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.recoverRetryTimer) clearTimeout(this.recoverRetryTimer);
    if (this.adminMessageTimer) clearTimeout(this.adminMessageTimer);
    document.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    window.removeEventListener('pagehide', this.onBeforeUnload);
    window.removeEventListener('app:playerBack', this.onPlayerBackEvent);
    if (this.isNative) {
      screen.orientation?.removeEventListener('change', this.onOrientationChange);
      if (Capacitor.getPlatform() === 'ios') Orientation.unlock().catch(() => {});
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
    this.wireSessionExpiredRecovery(engine);
  }

  private async createWebOsEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    // webOS plays through the same visible <video> the Shaka path uses —
    // the platform pipeline decodes natively. No transparent hardware
    // plane (Tizen/Capacitor), so the Shaka UX (isNativeEngine=false) fits.
    const engine = new WebOsEngine();
    await engine.init(video);
    this.engine = engine;
    this.isNativeEngine.set(false);
    this.state.bindEngine(engine);

    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireSessionExpiredRecovery(engine);
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
    this.wireSessionExpiredRecovery(engine);

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

    this.wireNativePlayerEngine(engine);
  }

  private async createDesktopEngine(): Promise<void> {
    const video = this.videoEl()!.nativeElement;
    video.style.display = 'none';

    const engine = new DesktopEngine();
    const container = this.containerEl()?.nativeElement ?? video.parentElement!;
    await engine.init(container);

    // Transparent page above the mpv video window — same hook the Capacitor
    // native engine uses to show the hardware surface through the WebView.
    document.documentElement.classList.add('native-player-active');

    this.wireNativePlayerEngine(engine);
  }

  /** Shared wiring for the transparent-overlay native engines (Capacitor
   *  ExoPlayer/AVPlayer and Electron mpv): bind state, surface the first
   *  frame, arm session-expired recovery, and reconcile the audio-track list
   *  against the backend streamInfo so labels match the media-detail header. */
  private wireNativePlayerEngine(engine: PlaybackEngine): void {
    this.engine = engine;
    this.isNativeEngine.set(true);
    this.state.bindEngine(engine);

    // videoStarted flips on the engine 'firstFrame' event so the
    // spinner+fanart stay until the surface is actually painting. No separate
    // stateChanged 'playing' hook needed — that can precede the first frame.
    engine.on('firstFrame', () => {
      this.state.videoStarted.set(true);
    });
    this.wireSessionExpiredRecovery(engine);

    // Engine audio tracks may emit multiple times (e.g. rendition switch) —
    // never overwrite a good list with a smaller one. BUT always let
    // engine-sourced tracks (audio-* / shaka-*) replace the streamInfo
    // fallback (si-*), even at equal length — their IDs enable client-side
    // PID switching instead of a full backend reload.
    engine.on('audioTracksChanged', (e) => {
      // Cross-reference engine tracks with streamInfo.audio so the dropdown
      // label matches what the media-detail header shows. Engine emits tracks
      // in streamInfo order. Offline there's no media loaded, so fall back to
      // the audio metadata captured on the download task at download time.
      let audioList: { language?: string }[];
      if (this.isOfflinePlayback) {
        const task = this.dlCache
          .load()
          .find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready');
        audioList = task?.audioStreams ?? [];
      } else {
        const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
        audioList = (file?.streamInfo as any)?.audio ?? [];
      }
      const tracks = e.tracks.map((t: any, i: number) => ({
        id: t.id,
        label: audioList[i] ? formatAudioLabel(audioList[i], this.translate, i + 1) : t.label,
        menuHead: audioList[i] ? formatAudioParts(audioList[i], this.translate, i + 1).head : t.label,
        menuSub: audioList[i] ? formatAudioParts(audioList[i], this.translate, i + 1).sub : '',
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
      // otherwise a transient partial emission would wipe the full si-* list.
      const upgradeFromFallback =
        newIsEngineSourced && existingIsFallback && tracks.length >= existing.length;
      if (tracks.length <= existing.length && !upgradeFromFallback) return;
      this.availableAudioTracks.set(tracks);
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

  /** The webOS Magic Remote's scroll wheel and center-button press arrive as
   *  `wheel` / `click` events at the pointer, not `keydown`, so the D-pad wake
   *  path in `onKeyDown` never sees them — and `mousemove` is intentionally
   *  muted on dpad input to avoid pointer-drift waking the bar. Wake the
   *  controls for those discrete, intentional pointer gestures. */
  wakeControlsFromPointer() {
    if (this.device.isDpad() && !this.controlsVisible()) this.showControls();
  }

  /** Move focus to the seekbar after the controls bar has rendered/become
   *  visible. Deferred so it lands after the controls' own "focus play/pause on
   *  reappear" effect, which would otherwise win the focus race on TV. */
  private focusSeekbar() {
    setTimeout(() => this.controls()?.focusSeekbar(), 0);
  }

  private hideControls() {
    this.controlsVisible.set(false);
    // Blur whatever was focused inside the controls so the next remote
    // Enter/OK doesn't accidentally activate an invisible button
    // (notably the back arrow at the top of the bar, which would quit
    // the player). The next D-pad / OK press will fall through to the
    // global key handler, show controls, and the user can navigate
    // them deliberately.
    if (typeof document !== 'undefined') {
      const active = document.activeElement as HTMLElement | null;
      // A floating cue outlives the bar's auto-hide — it stays on screen and
      // operable — so keep its focus; only blur controls that are hiding.
      if (
        active &&
        active.closest('app-player-controls') &&
        !active.closest('.player-floating-cue')
      ) {
        active.blur();
      }
    }
  }

  /** Restart the auto-hide countdown by registering activity. The reactive
   *  `autoHideEffect` owns the actual timer and re-arms off this bump and off
   *  the live pin state ({@link keepControlsUp}). */
  private resetHideTimer() {
    this.controlsActivity.update(n => n + 1);
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
    if (open) this.controlsVisible.set(true);
    else this.resetHideTimer();
  }

  // ── Player actions ──

  onTogglePlay() {
    if (!this.engine) return;
    // Coalesce rapid taps (spacebar / k / button spam): a second toggle
    // inside this window is dropped so a burst can't interleave a
    // play()/pause() with an in-flight MSE append and desync A/V.
    const now = Date.now();
    if (now - this.lastTogglePlayAt < this.togglePlayCoalesceMs) return;
    this.lastTogglePlayAt = now;
    // Decide off the engine's live transport state rather than the `paused()`
    // signal, which mirrors the async DOM/bridge play/pause events and lags a
    // tap, so reading it can issue two same-direction commands. On the web
    // <video> the getter is exact (paused flips synchronously); the native
    // engine mirrors its bridge state, which the coalesce window covers.
    // Reflect the target in the UI immediately instead of waiting for the
    // engine's `stateChanged` round-trip (on the desktop mpv backend that loop
    // — IPC → mpv property-observe → IPC back — can lag ~1s). The engine event
    // reasserts the real state, and a rejected command reverts to it.
    if (this.engine.paused) {
      this.state.paused.set(false);
      this.engine.play().catch(() => this.state.paused.set(this.engine?.paused ?? true));
      this.resetHideTimer();
    } else {
      this.state.paused.set(true);
      this.engine.pause().catch(() => this.state.paused.set(this.engine?.paused ?? true));
    }
  }

  onSeekDragChange(dragging: boolean) {
    this.seekDragging.set(dragging);
    if (dragging) {
      // Freeze the engine→state mirror while the user is dragging /
      // scrubbing the seekbar — otherwise the player's `timeUpdate`
      // stream keeps pushing the bar back to the live position under
      // the user's finger / arrow keys. The drag itself pins the controls
      // open via keepControlsUp.
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
      this.lastSeekAt = Date.now();
      if (this.desktopFarSeekNeedsReload(t)) void this.seekByReload(t);
      else void this.awaitSeekUnlock(t);
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

  /** Desktop mpv multi-audio transcode only: true when `target` falls outside
   *  mpv's demuxer cache, where an in-place seek would force its ffmpeg HLS
   *  demuxer to re-seek across the separate video/audio child playlists. Those
   *  reload at the offset (see {@link seekByReload}); everything else — Shaka,
   *  DirectPlay, remux, single-audio — keeps the instant in-place seek. */
  private desktopFarSeekNeedsReload(target: number): boolean {
    if (
      !this.isDesktopNative ||
      !(this.engine instanceof DesktopEngine) ||
      this.playbackMode() !== 'transcode' ||
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

  /** Far-seek path: reload the stream anchored at `target` (a fresh session
   *  prewarmed at the offset) rather than seeking in place, then release the
   *  seekbar lock once the playhead converges. Serialised against any other
   *  reload via {@link reloadingStream}. */
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
      await this.refreshSidAndReload(target, {
        preservePause: true,
        unmute: false,
      });
      this.resetStallWatchdog();
      this.state.loading.set(false);
      await this.pollSeekConverge(target, gen);
    } catch (e) {
      console.error('[Player] far-seek reload failed:', e);
      this.state.loading.set(false);
    } finally {
      this.reloadingStream = false;
    }
  }

  // ── Skip-intro UX ──

  /** True when the cursor is inside the detected intro window. */
  readonly inIntroRange = computed(() => {
    const m = this.introMarker();
    if (!m) return false;
    const t = this.currentTime();
    return t >= m.startSeconds && t < m.endSeconds - 1;
  });

  // ── Timed reveal of the floating intro / next-episode cues ──
  // A cue surfaces for a short window when the playhead enters its marker
  // range, then retracts on its own; a progress sweep inside the button counts
  // that window down. Revealing once per range entry (latched via the *Armed
  // flags) stops the cue re-popping every frame while the playhead sits inside
  // the range — the latch only re-arms once the playhead has left and re-entered.

  /** Lifetime of a floating cue, in ms — also the duration of its progress
   *  sweep, forwarded to the controls so the timer and the animation stay in
   *  lockstep. */
  readonly cueRevealMs = 6000;
  readonly skipIntroVisible = signal(false);
  readonly nextEpisodeVisible = signal(false);
  private skipIntroCueArmed = false;
  private nextEpisodeCueArmed = false;

  /** Show a cue and arm its retract, replacing any pending one. The retract
   *  starts frozen if the controls bar is already up — the cue waits for the
   *  viewer's attention to leave before counting itself down. */
  private revealCue(visible: WritableSignal<boolean>, cue: PausableTimeout): void {
    visible.set(true);
    cue.start(this.cueRevealMs);
    if (untracked(this.controlsVisible)) cue.pause();
  }

  /** Hide a cue and cancel its pending retract. */
  private hideCue(visible: WritableSignal<boolean>, cue: PausableTimeout): void {
    cue.cancel();
    visible.set(false);
  }

  /** Freeze both cues' retract timers while the cue is engaged — the controls
   *  bar is up, or the cue itself holds focus (a keyboard / D-pad user has
   *  navigated to it) — and resume them once it isn't. The sweep and countdown
   *  in the controls component freeze on the same conditions, so all three
   *  representations of the window stay in lockstep. */
  private readonly cueTimerPauseEffect = effect(() => {
    const engaged =
      this.controlsVisible() || (this.controls()?.cueFocused() ?? false);
    if (engaged) {
      this.skipIntroCue.pause();
      this.nextEpisodeCue.pause();
    } else {
      this.skipIntroCue.resume();
      this.nextEpisodeCue.resume();
    }
  });

  /** Reveal the skip-intro cue once each time the playhead enters the intro. */
  private readonly skipIntroCueEffect = effect(() => {
    if (this.inIntroRange()) {
      if (this.skipIntroCueArmed) return;
      this.skipIntroCueArmed = true;
      this.revealCue(this.skipIntroVisible, this.skipIntroCue);
    } else if (this.skipIntroCueArmed) {
      this.skipIntroCueArmed = false;
      this.hideCue(this.skipIntroVisible, this.skipIntroCue);
    }
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

  /** The item that plays next: the queue's next entry (a playlist item, or the
   *  next episode of the series queue). Null when nothing follows or there's no
   *  queue (a standalone film). Drives the skip control and auto-advance alike. */
  readonly upNext = computed<QueueItem | null>(() =>
    this.queue.active() ? this.queue.peekNext() : null,
  );

  /** Whether the current context advances automatically when a stream ends: the
   *  per-playlist flag for a playlist queue, else the global player setting
   *  (series episodes). */
  readonly autoplayEnabled = computed<boolean>(() =>
    this.queue.source() === 'playlist'
      ? this.queue.autoplay()
      : this.playerSettings.settings().autoPlayNext,
  );

  /** i18n key for the next-item affordance — an episode reads "next episode",
   *  a queue that moves to a movie reads the generic "play next". */
  readonly nextLabelKey = computed(() =>
    this.upNext()?.episodeId != null ? 'player.next_episode' : 'player.play_next',
  );

  /** The active queue's items + cursor for the in-player queue list (empty when
   *  no queue is driving playback, e.g. a standalone film or a lone series). */
  readonly queueItems = computed(() => this.queue.items());
  readonly queueIndex = computed(() => this.queue.index());

  /** True when the cursor is inside the detected outro window. */
  readonly inOutroRange = computed(() => {
    const m = this.outroMarker();
    if (!m) return false;
    return this.currentTime() >= m.startSeconds;
  });

  /** True when the playhead is in the outro and something follows — gates the
   *  timed reveal of the floating skip cue. */
  readonly showNextEpisodeButton = computed(
    () => this.inOutroRange() && this.upNext() !== null,
  );

  /** Reveal the next-episode cue once each time the playhead enters the outro. */
  private readonly nextEpisodeCueEffect = effect(() => {
    if (this.showNextEpisodeButton()) {
      if (this.nextEpisodeCueArmed) return;
      this.nextEpisodeCueArmed = true;
      this.revealCue(this.nextEpisodeVisible, this.nextEpisodeCue);
    } else if (this.nextEpisodeCueArmed) {
      this.nextEpisodeCueArmed = false;
      this.hideCue(this.nextEpisodeVisible, this.nextEpisodeCue);
    }
  });

  /** Auto-advance when a stream reaches its natural end and the context allows
   *  it. {@link PlayerStateService.ended} latches on the engine 'ended' event
   *  and is cleared by the reload's state reset, so this fires once per item.
   *  Never advances while an error card is up: a mid-stream failure must not be
   *  mistaken for a natural end and skip the item. */
  private readonly autoAdvanceEffect = effect(() => {
    if (!this.state.ended()) return;
    if (this.state.error()) return;
    if (!this.autoplayEnabled()) return;
    if (!this.upNext()) return;
    void this.advance();
  });

  /** Set the episode label + still backdrop from {@link media} and the current
   *  {@link episodeId} (no-op for movies). Shared by the initial load and the
   *  in-place episode switch so the loading backdrop matches what's about to
   *  play — the episode still (stored locally) is preferred over series fanart. */
  /** Populate the queue with the current series' episodes (S/E order, only ones
   *  with a file) so the queue list + auto-advance work for a series played
   *  outside a playlist — wherever an episode is opened (Continue Watching,
   *  detail page, …). No-op while a playlist owns the queue; clears the queue
   *  for movies or when the current episode has no queue-able siblings. */
  private syncSeriesQueue(): void {
    if (this.queue.source() === 'playlist') return; // the playlist owns the queue
    const m = this.media;
    if (!m || m.type !== 'series' || !this.episodeId || !m.seasons?.length) {
      this.queue.clear();
      return;
    }
    const flat: {
      seasonNumber: number;
      episodeNumber: number;
      id: number;
      title?: string | null;
      stillUrl?: string | null;
    }[] = [];
    for (const s of m.seasons) {
      if ((s.seasonNumber ?? 0) <= 0) continue; // skip specials
      for (const ep of s.episodes ?? []) {
        flat.push({
          seasonNumber: s.seasonNumber,
          episodeNumber: ep.episodeNumber ?? 0,
          id: ep.id,
          title: ep.title,
          stillUrl: ep.stillUrl,
        });
      }
    }
    flat.sort(
      (a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber,
    );
    const items: QueueItem[] = [];
    for (const e of flat) {
      const file = (m.files ?? []).find((f) => f.episodeId === e.id);
      if (!file) continue; // an episode with no available file isn't queue-able
      items.push({
        mediaId: m.id,
        episodeId: e.id,
        mediaFileId: file.id,
        title: m.title,
        episodeTitle: `S${e.seasonNumber}:E${e.episodeNumber}${e.title ? ` - ${e.title}` : ''}`,
        fanartUrl: m.fanartUrl,
        stillUrl: e.stillUrl ?? null,
      });
    }
    const idx = items.findIndex((it) => it.episodeId === this.episodeId);
    if (idx < 0 || items.length <= 1) {
      this.queue.clear();
      return;
    }
    this.queue.start(items, idx, { source: 'series', sourceId: m.id, autoplay: false });
  }

  private applyEpisodeMetadata(): void {
    // A movie (or an item with no episode) carries no episode label — clear any
    // that lingered from a previous episode when a queue crosses into a movie.
    if (!this.episodeId || !this.media?.seasons) {
      this.episodeTitle.set('');
      return;
    }
    for (const season of this.media.seasons) {
      const ep = season.episodes?.find((e) => e.id === this.episodeId);
      if (!ep) continue;
      const label = `S${season.seasonNumber}:E${ep.episodeNumber}`;
      this.episodeTitle.set(ep.title ? `${label} - ${ep.title}` : label);
      if (ep.stillUrl) {
        this.fanartUrl.set(this.serverConfig.resolveUrl(ep.stillUrl));
      }
      return;
    }
  }

  /** Switch to another episode of the open series without tearing the player
   *  down: reuse the engine and swap the source (same path as
   *  {@link doReloadStream}), refreshing the episode-scoped state — markers,
   *  chapters, subtitles, sprites, metadata and resume position. The only
   *  visible change is the new episode's backdrop during the brief reload, so
   *  there's no close/reopen flash. Serialised against quality / audio reloads
   *  via {@link reloadingStream}. */
  private async reloadForEpisode(
    mediaFileId: number,
    mediaId: number,
    episodeId: number | undefined,
  ): Promise<void> {
    if (!this.engine || this.reloadingStream || mediaFileId === this.mediaFileId) return;
    this.reloadingStream = true;
    this.engine.resetRecoveryGuard();
    const previousFileId = this.mediaFileId;
    const previousSessionId = this.playbackInfo?.sessionId;
    try {
      // Surface the loading backdrop (set to the new episode's still below)
      // over the outgoing frame and rewind the playhead UI to the start.
      this.state.reset();
      // Drop the outgoing episode's negotiated info so a failure before the
      // new getPlaybackInfo resolves reports no playMethod/hwAccel rather
      // than the previous episode's stale values.
      this.playbackInfo = null;

      // Native engines must be stopped before a fresh load to avoid a freeze;
      // release the outgoing file's session (other devices on it stay alive).
      if (this.isNativeEngine()) await NativePlayer.stop().catch(() => {});
      await this.streamingApi
        .stopSessions(previousFileId, previousSessionId)
        .catch(() => {});

      this.mediaFileId = mediaFileId;
      this.episodeId = episodeId;
      this.activeBurnInId = null;
      // Same series → media is unchanged; reload it only if the id differs
      // (a queue can cross media). Refresh the title/logo when it does.
      if (mediaId && mediaId !== this.mediaId) {
        this.mediaId = mediaId;
        this.media = await this.mediaService.getOne(mediaId);
        this.mediaTitle.set(this.media.title);
        this.mediaLogoUrl.set(this.media.logoUrl ?? null);
      }
      // Recompute next-item context + refresh the episode label / backdrop.
      this.mediaLoadedTick.update((v) => v + 1);
      this.applyEpisodeMetadata();
      this.syncSeriesQueue();

      const file = this.media?.files?.find((f: any) => f.id === this.mediaFileId);
      const knownDuration = (file?.streamInfo as any)?.durationSeconds;
      if (knownDuration && knownDuration > 0) this.state.duration.set(knownDuration);

      // Resume point of the incoming episode (usually the start).
      let startTime: number | undefined;
      const playbackState = await this.streamingApi
        .getPlaybackState(this.mediaId, this.episodeId)
        .catch(() => null);
      if (playbackState && !playbackState.completed && playbackState.positionSeconds > 10) {
        startTime = playbackState.positionSeconds;
      }

      // Audio preference for the new file (UI/state; the backend picks the
      // default during playback-info negotiation).
      const audioStreams: { language?: string }[] = (file?.streamInfo as any)?.audio ?? [];
      this.activeAudioStreamIndex = this.playerSettings.resolveAudioStreamIndex(
        this.mediaFileId, audioStreams, this.mediaId,
      );

      // Re-negotiate the stream for the new file (DirectPlay vs the ladder).
      await this.authService.ensureStreamToken();
      const deviceProfile = this.deviceProfileService.getProfile();
      const requestedQuality = this.resolveStartQuality();
      this.playbackInfo = await this.streamingApi.getPlaybackInfo(
        this.mediaFileId,
        deviceProfile,
        undefined,
        this.activeAudioStreamIndex,
        requestedQuality,
      );
      const pi = this.playbackInfo;
      this.introMarker.set(pi.markers?.intro ?? null);
      this.outroMarker.set(pi.markers?.outro ?? null);
      this.chapters.set(pi.chapters ?? []);
      this.state.playbackMode.set(
        pi.playMethod === 'DirectPlay'
          ? 'direct'
          : pi.playMethod === 'DirectStream'
            ? 'remux'
            : 'transcode',
      );
      this.state.hwAccel.set(pi.hwAccel);
      this.qualityManager.buildQualityOptions(pi);

      const { url, mimeType } = this.buildPlayUrl({ startTime });
      await this.engine.load(url, startTime, mimeType);
      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, this.playbackMode());

      // Fresh subtitle + audio track lists for the new file, then auto-select.
      const subs = await this.trackManager.loadSubtitles(
        this.mediaId, this.mediaFileId, this.streamingApi, this.media,
      );
      this.availableSubtitles.set(subs);
      this.loadAudioTracks();
      await this.trackManager.autoSelectSubtitle(
        this.availableSubtitles(),
        this.availableAudioTracks(),
        this.activeAudioTrackId(),
        this.mediaFileId,
        (sub) => this.selectSubtitle(sub),
        this.mediaId,
      );

      // Refresh the seek-preview sprites for the new file.
      this.spriteAbort?.abort();
      void this.loadSpriteMetadata();

      if (!this.isNativeEngine()) this.engine.play().catch(() => {});
      // Reveal the controls across the switch so the new title/episode shows;
      // the flag lets them stay through the first frame and then auto-hide on
      // the usual timer (see autoHideOnPlayEffect).
      this.revealAcrossSwitch = true;
      this.controlsVisible.set(true);
    } catch (e: any) {
      // Map to a translated line (Shaka-shaped errors keep their category
      // message, a failed playback-info request its transport status) and
      // keep the raw engine/exception text in the diagnostics `message`
      // field only — the card body never shows an untranslated string.
      const { source, code } = classifyPlaybackError(e);
      this.state.setError(
        this.translate.instant(
          userMessageKeyFor({
            source,
            code,
            category: e?.category,
            dolbyVision: this.isDolbyVisionPassthrough(),
          }),
        ),
        {
          source,
          code,
          category: e?.category,
          data: e?.data,
          message: e?.message ?? String(e),
        },
      );
    } finally {
      this.reloadingStream = false;
      this.state.loading.set(false);
    }
  }

  /** Mark the item currently playing as completed server-side, so advancing
   *  past it (auto or manual) counts as watched.
   *  Backend threshold: position >= duration - 30s OR position >= duration * 0.9. */
  private async markCurrentComplete(): Promise<void> {
    if (!this.mediaId) return;
    const dur =
      (this.castService.isConnected()
        ? this.castService.duration()
        : this.engine?.duration) ||
      this.duration() ||
      0;
    if (dur <= 0) return;
    try {
      await this.streamingApi.updatePlaybackState(this.mediaId, {
        positionSeconds: dur,
        durationSeconds: dur,
        mediaFileId: this.mediaFileId,
        episodeId: this.episodeId,
      });
    } catch {
      /* non-blocking — advance even if the update fails */
    }
  }

  /** Guards {@link advance} against re-entry while a switch is resolving (a
   *  manual click racing the end-of-stream auto-advance, or the effect
   *  re-firing before the reload's state reset clears `ended`). */
  private advancing = false;

  /** Resolve a queue item's playable file id — carried on series-next items,
   *  looked up lazily (media fetch) for playlist items. Null when the item's
   *  media has no available file. */
  private async resolveItemFileId(item: QueueItem): Promise<number | null> {
    if (item.mediaFileId != null) return item.mediaFileId;
    const media = await this.mediaService.getOne(item.mediaId).catch(() => null);
    return media ? (resolvePlayableFile(media, item.episodeId)?.id ?? null) : null;
  }

  /** Advance to {@link upNext}: mark the current item watched, resolve the next
   *  playable file (series-next carries it; playlist items resolve lazily) and
   *  load it in place — reusing the mounted player so there's no close/reopen
   *  flash, updating the URL (the /watch route is reused, so no remount).
   *  Offline and Cast keep the full remount: their source isn't a re-negotiable
   *  local stream. Drives both the manual skip control and auto-advance.
   *
   *  Playlist items whose file is unavailable (e.g. not downloaded yet) are
   *  skipped so a gap in the middle doesn't dead-end the rest of the queue. */
  async advance(): Promise<void> {
    // Don't stack on an in-flight quality/audio reload: it would move the queue
    // cursor while the current item is still (re)loading. The manual control
    // stays usable once the reload settles.
    if (this.advancing || this.reloadingStream) return;
    if (!this.upNext()) return;
    this.advancing = true;
    try {
      await this.markCurrentComplete();

      // Pick the next playable item. For a queue, walk the cursor forward over
      // any unavailable items; series-next always resolves to a stored file.
      let item: QueueItem | null;
      let mediaFileId: number | null;
      let skipped = 0;
      if (this.queue.active()) {
        item = this.queue.advance();
        mediaFileId = item ? await this.resolveItemFileId(item) : null;
        while (item && mediaFileId == null) {
          skipped++;
          item = this.queue.advance();
          mediaFileId = item ? await this.resolveItemFileId(item) : null;
        }
      } else {
        item = this.upNext();
        mediaFileId = item?.mediaFileId ?? null;
      }

      if (!item || mediaFileId == null) {
        if (skipped > 0) {
          this.toast.error(this.translate.instant('player.next_unavailable'));
        }
        return;
      }

      await this.loadItem(item, mediaFileId);
    } finally {
      this.advancing = false;
    }
  }

  /** Jump to an explicit queue item (the user picked it in the queue list).
   *  Unlike {@link advance} it does NOT mark the current item watched — a jump
   *  isn't finishing — and it does not skip: the user chose this item. */
  async playQueueItem(index: number): Promise<void> {
    if (this.advancing || this.reloadingStream) return;
    if (index === this.queue.index()) return; // already playing it
    const item = this.queue.items()[index];
    if (!item) return;
    this.advancing = true;
    try {
      const mediaFileId = await this.resolveItemFileId(item);
      if (mediaFileId == null) {
        this.toast.error(this.translate.instant('player.next_unavailable'));
        return;
      }
      this.queue.setIndex(index);
      await this.loadItem(item, mediaFileId);
    } finally {
      this.advancing = false;
    }
  }

  /** Load a resolved queue item into the mounted player (in place, no remount)
   *  or via a full remount for offline / Cast. Shared by {@link advance} and
   *  {@link playQueueItem}; the cursor is expected to already point at `item`. */
  private async loadItem(item: QueueItem, mediaFileId: number): Promise<void> {
    // Committing to the item — clear the end-of-stream latch so a reload that
    // no-ops can't leave it set and re-trigger the auto-advance effect.
    this.state.ended.set(false);

    const qp: Record<string, number> = { mediaId: item.mediaId };
    if (item.episodeId) qp['episodeId'] = item.episodeId;
    const sourceId = this.queue.sourceId();
    // Only a playlist queue is re-established from the URL; a series queue is
    // rebuilt from the loaded media, so it needs no param.
    if (this.queue.source() === 'playlist' && sourceId != null) {
      qp['playlistId'] = sourceId;
    }

    const canReloadInPlace =
      !!this.engine && !this.isOfflinePlayback && !this.castService.isConnected();
    if (canReloadInPlace) {
      // Match the incoming item's backdrop during the brief reload (the episode
      // still, else the media fanart) so it's not the outgoing frame.
      const backdrop = item.stillUrl ?? item.fanartUrl;
      if (backdrop) this.fanartUrl.set(this.serverConfig.resolveUrl(backdrop));
      // replaceUrl + markAsBackNavigation keep both histories clear of the old
      // item so Back never reopens the player. Route reuse → no remount.
      this.navbar.markAsBackNavigation();
      void this.router.navigate(['/watch', mediaFileId], {
        queryParams: qp,
        replaceUrl: true,
      });
      await this.reloadForEpisode(mediaFileId, item.mediaId, item.episodeId);
      return;
    }

    // Offline / Cast fallback: detour through `/` to force a fresh remount (the
    // default router would otherwise reuse the component and never re-read the
    // snapshot params).
    void this.router
      .navigateByUrl('/', { skipLocationChange: true })
      .then(() =>
        this.router.navigate(['/watch', mediaFileId], {
          queryParams: qp,
          replaceUrl: true,
        }),
      );
  }

  onVolumeChange(vol: number) {
    if (!this.engine) return;
    // Dragging the slider sets the level and lifts a mute — the state signals
    // update via the engine's `volumechange` event, keeping the display in
    // lockstep with the real output on every engine.
    this.engine.volume = vol;
    if (vol > 0 && this.engine.muted) this.engine.muted = false;
  }

  onToggleMute() {
    if (!this.engine) return;
    // Toggle audible/silent, not the raw mute flag: when already silent —
    // either muted or the level dragged to 0 — a click restores sound, bumping
    // a zero level back to full so the button never appears stuck on mute.
    const silent = this.engine.muted || this.engine.volume === 0;
    if (silent) {
      this.engine.muted = false;
      if (this.engine.volume === 0) this.engine.volume = 1;
    } else {
      this.engine.muted = true;
    }
  }

  onToggleFullscreen() {
    // Desktop compositor: the visible surface is the native (SDL) window owned
    // by the addon, not this offscreen WebView, so toggle fullscreen there.
    if (this.isDesktopNative && this.engine instanceof DesktopEngine) {
      this.engine.setFullscreen(!this.engine.fullscreen);
      return;
    }
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

  onToggleOrientationLock() {
    const locked = !this.orientationLocked();
    this.orientationLocked.set(locked);
    (locked ? Orientation.lock() : Orientation.unlock()).catch(() => {});
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

  /**
   * Resolve the `startQuality` wire value: the explicit rung id, or — only
   * in 'auto' — the top rung when the active engine has no client-side ABR,
   * so a no-ABR engine (desktop mpv) still gets pinned to a single variant
   * instead of the full backend ladder. Single source for every
   * playback-info / stream-url call site.
   */
  private resolveStartQuality(): string | undefined {
    const active = this.activeQualityId();
    if (active !== 'auto') return active;
    const supportsAbr = this.deviceProfileService.getProfile().supportsAbr ?? true;
    return supportsAbr ? undefined : this.qualityManager.topRungId();
  }

  /**
   * Compose the engine's stream URL for the current `playbackMode`.
   * Returns `{ url, mimeType }` — direct play needs the explicit
   * `video/mp4` content type for native + Tizen engines, HLS lets the
   * engine sniff. `startTime` is only consumed by HLS (lets the
   * backend pre-spawn ffmpeg at the right offset); reload paths
   * intentionally omit it because the engine seeks after `load`.
   */
  private buildPlayUrl(opts: {
    sid?: string | null;
    startTime?: number;
  } = {}): { url: string; mimeType?: string } {
    const mode = this.playbackMode();
    const sid = opts.sid ?? this.playbackInfo?.sessionId;
    let built: { url: string; mimeType?: string };
    if (mode === 'direct') {
      built = {
        url: this.streamingApi.getStreamUrl(this.mediaFileId, sid),
        mimeType: 'video/mp4',
      };
    } else {
      const startQuality = this.resolveStartQuality();
      built = {
        url: this.streamingApi.getHlsUrl(
          this.mediaFileId,
          startQuality,
          opts.startTime,
          sid,
        ),
      };
    }
    this.lastStreamUrl = built.url;
    return built;
  }

  /**
   * Mint a fresh LiveSession via `playback-info` and reload the
   * engine at `pos` with the new sid. Shared body between
   * {@link resumeLocalAfterCast} (Cast disconnect — also unmutes) and
   * {@link recoverFromLostSession} (heartbeat said sid is unknown —
   * preserves a pre-existing pause). HLS routes intentionally drop
   * `startTime` on the URL because the engine handles the seek after
   * `load`.
   */
  private async refreshSidAndReload(
    pos: number,
    opts: { preservePause: boolean; unmute: boolean },
  ): Promise<void> {
    if (!this.engine || !this.mediaFileId) return;
    this.state.buffering.set(true);
    try {
      // Drop the prior sid before minting a new one, and await it: a stall
      // recovery still has a live prior session, and the backend would otherwise
      // treat the re-mint as a concurrent sibling and split it onto a cold job.
      const prevSid = this.playbackInfo?.sessionId;
      if (prevSid) {
        await this.streamingApi
          .stopSessions(this.mediaFileId, prevSid)
          .catch(() => {});
      }
      if (opts.unmute) this.engine.muted = false;
      const wasPaused = opts.preservePause ? this.paused() : false;
      const deviceProfile = this.deviceProfileService.getProfile();
      // Pass the active rung as startQuality so the backend prewarms ffmpeg at
      // the resume position — main session at -ss pos plus the bounded early
      // session that absorbs Shaka's seg-0 VOD probe. Mirrors the initial load.
      const prewarmQuality = this.resolveStartQuality();
      this.playbackInfo = await this.streamingApi.getPlaybackInfo(
        this.mediaFileId,
        deviceProfile,
        this.activeBurnInId ?? undefined,
        this.activeAudioStreamIndex ?? undefined,
        prewarmQuality,
        pos > 0 ? Math.floor(pos) : undefined,
      );
      // Refresh the near-expiry stream token before rebuilding the play URL:
      // it's baked into every segment URL and can't be swapped once the engine
      // loads, so a token that lapsed mid-film would 401 every segment.
      await this.authService.ensureStreamToken();
      const { url, mimeType } = this.buildPlayUrl({
        sid: this.playbackInfo.sessionId,
      });
      await this.engine.load(url, pos > 0 ? pos : undefined, mimeType);
      this.qualityManager.applyQualityPreferenceAfterLoad(
        this.engine,
        this.playbackMode(),
      );
      // Shaka/webOS and the desktop mpv engine drop sidecar text tracks on a fresh
      // load(), so a recovery reload silently loses the user's subtitle. Re-add +
      // re-select the active soft subtitle. The Capacitor native players restore
      // their own pick inside load(); burn-in is re-baked server-side via the
      // activeBurnInId passed to playback-info above.
      if (!this.isNativeEngine() || this.isDesktopNative) {
        const activeId = this.activeSubtitleId();
        const sub = activeId
          ? this.availableSubtitles().find((s) => s.id === activeId)
          : null;
        if (sub && !sub.burnIn && sub.url) {
          try {
            const track = await this.engine.addTextTrack(
              sub.url,
              sub.language,
              sub.label,
              sub.forced,
              this.subtitleOrdinal(sub),
            );
            this.engine.selectTextTrack(track);
            this.engine.setTextVisibility(true);
          } catch (e) {
            console.error('[Player] re-apply subtitle after reload failed:', e);
          }
        }
      }
      this.restorePlayState(wasPaused);
    } finally {
      this.state.buffering.set(false);
    }
  }

  /**
   * Restore the engine to the play/pause state the user intended before a
   * reload. Every reload — quality / audio / subtitle switch and lost-session
   * recovery — must preserve whether playback is running; only the initial
   * launch autoplays. The native engine (ExoPlayer playWhenReady) autoplays on
   * load(), so a paused user must be actively re-paused after load, not merely
   * left unplayed. The single enforcement point keeps every reload path
   * consistent.
   */
  private restorePlayState(wasPaused: boolean): void {
    if (!this.engine) return;
    if (wasPaused) this.engine.pause().catch(() => {});
    else this.engine.play().catch(() => {});
  }

  /**
   * Guard so a slow recovery (~1-2 s of playback-info + reload) can't
   * race against the next 10-second heartbeat: we only fire one
   * recoverFromLostSession at a time, no matter how many heartbeats
   * surface `sessionLost: true` in the interval.
   */
  private recoveringFromLostSession = false;
  /** Recovery attempts in the current loss episode. Cleared only once a
   *  reload sustains playback (see {@link recoverConfirmPending}), NOT on the
   *  instant a reload resolves — a reload that succeeds then re-fails within
   *  seconds must keep counting toward {@link maxRecoverAttempts}, or it
   *  re-mints a fresh sid every iteration and loops forever. */
  private recoverAttempts = 0;
  private readonly maxRecoverAttempts = 3;
  /** Pending backoff retry between failed recovery attempts (2s → 4s). */
  private recoverRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A recovery reload just resolved; the episode counter and the native
   *  recovery guard are cleared only after the playhead advances for
   *  {@link recoverConfirmMs} (confirmed in checkStall). */
  private recoverConfirmPending = false;
  private recoverConfirmAt = 0;
  private readonly recoverConfirmMs = 5_000;
  /** Set in ngOnDestroy. Blocks any late async (heartbeat sessionLost,
   *  sessionExpired event, Cast resume) from reloading the engine after the
   *  player has been torn down — otherwise a fresh native player relaunches
   *  in the background once the user has navigated away. */
  private destroyed = false;

  /**
   * Hook into the engine's `sessionExpired` event so a backend 410 on
   * a segment / playlist request triggers recovery on the very next
   * tick instead of waiting for the 10 s heartbeat. Idempotent across
   * engines (Shaka / Tizen AVPlay / Capacitor native) — they all share
   * the same event contract on the PlaybackEngine interface.
   */
  private wireSessionExpiredRecovery(engine: PlaybackEngine): void {
    engine.on('sessionExpired', () => {
      void this.recoverFromLostSession();
    });
  }

  /** Re-baseline the stall watchdog so the next {@link stallTimeoutMs} window
   *  starts from the current playhead. Called after load, after a seek, and
   *  after a successful recovery — anywhere the playhead legitimately jumps. */
  private resetStallWatchdog(): void {
    this.lastProgressPos = this.engine?.currentTime ?? 0;
    this.lastProgressAt = Date.now();
  }

  /** Full technical dump shown in the error card's details block and copied
   *  by the "copy diagnostics" button — the Shaka code/category/severity,
   *  the failing variant, playback context, and any Shaka `data[]`. */
  errorDiagnostics(): string {
    const err = this.state.error();
    if (!err) return '';
    // playbackMode/hwAccel are only meaningful once a negotiation has
    // actually resolved — otherwise they still hold the previous title's
    // values (state.reset() doesn't clear them) and would misreport a
    // pre-negotiation failure as a negotiated DirectPlay.
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
    return episode ? `${title} — ${episode}` : title;
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

  async copyErrorDiagnostics(): Promise<void> {
    const text = this.errorDiagnostics();
    if (!text || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      this.errorCopied.set(true);
      setTimeout(() => this.errorCopied.set(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / denied permission) — no-op.
    }
  }

  /** True when the current media is Dolby Vision AND we're serving it untouched
   *  (DirectPlay / DirectStream): a decode failure is then a DV-capability
   *  failure, surfaced with an explicit message. A tonemapped transcode is not
   *  DV, so it stays on the generic error path. Read live at error time (via the
   *  probe registered on PlayerStateService) so it tracks quality switches. */
  private isDolbyVisionPassthrough(): boolean {
    const method = this.playbackInfo?.playMethod;
    if (method !== 'DirectPlay' && method !== 'DirectStream') return false;
    const v = this.media?.files?.find((f) => f.id === this.mediaFileId)
      ?.streamInfo?.video?.[0];
    return (v?.dvProfile ?? 0) > 0;
  }

  /** Ticked once a second from the stats interval. Detects a frozen playhead
   *  during intended playback and routes it through the same recovery as a
   *  lost session (re-mint sid + reload at position). */
  private checkStall(): void {
    if (this.destroyed || !this.engine) return;
    if (this.castService.isConnected()) return;
    // Not trying to play, or not playing yet → no stall to detect; keep the
    // baseline fresh so resuming/finishing-load doesn't trip the timer.
    // A fatal-no-retry error (undecodable stream) also bails: a fresh sid
    // can't fix a codec the browser rejects, so recovering only flaps the
    // card/spinner — show the terminal error instead.
    if (
      this.paused() ||
      this.state.loading() ||
      this.state.fatalNoRetry() ||
      this.recoveringFromLostSession ||
      this.reloadingStream
    ) {
      this.resetStallWatchdog();
      return;
    }
    const pos = this.engine.currentTime;
    const dur = this.engine.duration;
    if (dur && pos >= dur - 1) {
      this.resetStallWatchdog();
      return;
    }
    // Any meaningful move (forward play or a seek in either direction) counts
    // as progress and rearms the window.
    if (Math.abs(pos - this.lastProgressPos) > 0.25) {
      this.lastProgressPos = pos;
      this.lastProgressAt = Date.now();
      // A recovery that has sustained playback for recoverConfirmMs is clean:
      // clear the episode counter and re-arm the native one-shot guard so a
      // later, unrelated blip gets its own recovery instead of going fatal.
      if (
        this.recoverConfirmPending &&
        Date.now() - this.recoverConfirmAt >= this.recoverConfirmMs
      ) {
        this.recoverConfirmPending = false;
        this.recoverAttempts = 0;
        this.engine?.resetRecoveryGuard();
      }
      return;
    }
    const timeout =
      Date.now() - this.lastSeekAt < this.seekStallGraceMs
        ? this.seekStallGraceMs
        : this.stallTimeoutMs;
    if (Date.now() - this.lastProgressAt >= timeout) {
      this.resetStallWatchdog();
      void this.recoverFromLostSession();
    }
  }

  /**
   * The carried `sid` is no longer known to the backend (restart or
   * GC after a long idle), or the playhead wedged (stall watchdog). Mint
   * a fresh LiveSession via playback-info and reload the engine's stream
   * URL with the new sid at the current position. Retries with backoff
   * (2s → 4s) and surfaces a terminal error after {@link maxRecoverAttempts}
   * failures rather than reloading forever. Cast playbacks are skipped —
   * the cast receiver owns its own session lifecycle.
   */
  private async recoverFromLostSession(): Promise<void> {
    if (this.destroyed) return;
    if (this.recoveringFromLostSession) return;
    // A user reload (quality / audio switch, episode swap) re-mints the session
    // and reloads the engine itself; a 410 or a heartbeat sessionLost inside
    // that window is expected, and recovering here would race a second
    // getPlaybackInfo + engine.load onto the same engine. Clear any recovery
    // veil we were holding across a backoff — the in-flight reload now owns the
    // session — so it isn't leaked true after the reload settles.
    if (this.reloadingStream) {
      this.state.setRecovering(false);
      return;
    }
    if (this.recoverRetryTimer) return; // a backoff retry is already queued
    if (this.recoverAttempts >= this.maxRecoverAttempts) {
      // Exhausted recovery — surface a terminal error card instead of
      // returning silently, which would leave a stuck spinner (recovering
      // still veiled) or a stale overlay with no way out.
      this.state.setRecovering(false);
      if (!this.state.error()) {
        this.state.setError(
          this.translate.instant(userMessageKeyFor({ source: 'session' })),
          { source: 'session' },
        );
      }
      return;
    }
    if (this.castService.isConnected()) return;
    if (!this.engine || !this.mediaFileId) return;
    this.recoveringFromLostSession = true;
    // Suppress the fatal-error overlay the engine tears off as the stream
    // reloads — recovery is about to resume playback, so the reload window
    // reads as buffering, not "Playback error".
    this.state.setRecovering(true);
    // Count the attempt up front, not only on failure: a reload that resolves
    // then re-fails within seconds must keep counting toward maxRecoverAttempts.
    // On the Shaka path there is no per-engine one-shot latch, so a fresh sid
    // that 410s again on the next segment would otherwise re-enter with the
    // counter still at 0 and loop unbounded. The counter clears only after
    // playback sustains for recoverConfirmMs (checkStall).
    this.recoverAttempts += 1;
    // engine.currentTime can read 0 right after an error (e.g. Tizen AVPlay),
    // which would reload from the start — fall back to the last mirrored
    // position in that case.
    const enginePos = this.engine.currentTime;
    const pos = enginePos > 1 ? enginePos : this.state.currentTime();
    try {
      await this.refreshSidAndReload(pos, {
        preservePause: true,
        unmute: false,
      });
      this.resetStallWatchdog();
      this.state.setRecovering(false);
      // Don't clear the episode counter yet — only once the reload proves it
      // plays (checkStall confirms sustained progress). A reload that resolves
      // then immediately re-fails keeps counting toward the cap.
      this.recoverConfirmPending = true;
      this.recoverConfirmAt = Date.now();
    } catch (e) {
      if (this.recoverAttempts >= this.maxRecoverAttempts) {
        this.state.setRecovering(false);
        const { source, code } = classifyPlaybackError(e);
        this.state.setError(
          this.translate.instant(userMessageKeyFor({ source, code })),
          { source, code, message: (e as any)?.message ?? String(e) },
        );
      } else {
        // Hold the recovering veil up across the backoff so the user sees a
        // reconnect, not a flash of the fatal overlay between attempts.
        const backoff = 2_000 * 2 ** (this.recoverAttempts - 1); // 2s, 4s
        this.recoverRetryTimer = setTimeout(() => {
          this.recoverRetryTimer = null;
          void this.recoverFromLostSession();
        }, backoff);
      }
    } finally {
      this.recoveringFromLostSession = false;
    }
  }

  /** Reload local engine and resume after Cast disconnect. The
   *  browser's pre-cast LiveSession was GC'd while the cast receiver
   *  held the only live entry, so we mint a fresh sid before
   *  reloading — reusing `this.playbackInfo?.sessionId` would race
   *  against the heartbeat fallback path and flash a reload. */
  private async resumeLocalAfterCast(castPos: number) {
    if (this.destroyed) return;
    try {
      await this.refreshSidAndReload(castPos, {
        preservePause: false,
        unmute: true,
      });
    } catch (e) {
      // No retry path after a Cast disconnect — surface a terminal error
      // instead of leaving the local player silently dead.
      const { source, code } = classifyPlaybackError(e);
      this.state.setError(
        this.translate.instant(userMessageKeyFor({ source, code })),
        { source, code, message: (e as any)?.message ?? String(e) },
      );
    }
  }

  onSpeedChange(rate: number) {
    if (!this.engine) return;
    this.engine.playbackRate = rate;
    this.playbackRate.set(rate);
  }

  /** Whether the episode reached the completion threshold — mirrors the
   *  backend (within 30s of the end, or past 90%). Drives the "back" target:
   *  a finished episode returns to the next one. */
  private episodeFinished(): boolean {
    const dur = this.duration();
    const pos = this.currentTime();
    return dur > 0 && (pos >= dur - 30 || pos >= dur * 0.9);
  }

  onBack() {
    this.savePosition();
    // Desktop compositor: leaving the player drops the native (SDL) window out
    // of fullscreen so the rest of the app isn't stuck fullscreen. Item
    // switches route through advance(), not onBack(), so they keep it.
    if (this.isDesktopNative && this.engine instanceof DesktopEngine && this.engine.fullscreen) {
      this.engine.setFullscreen(false);
    }
    // Explicit navigation rather than history.back() — nav-inside-player
    // (e.g. next-episode) leaves multiple /watch entries on the stack, and
    // router-reuse across same routes means history.back() only rewrites
    // the URL without exiting the player.
    // replaceUrl drops /watch from history so hardware/browser back does not
    // reopen the player on the way back.
    const queueSourceId = this.queue.sourceId();
    let target: string;
    if (!this.mediaId) {
      target = '/';
    } else if (this.queue.source() === 'playlist' && queueSourceId != null) {
      // Playing from a playlist returns to that playlist, not the item's page.
      target = `/playlists/${queueSourceId}`;
    } else {
      // Offline playback never loads `this.media`; fall back to the type stored
      // on the download task so a downloaded series routes to /series, not
      // /movies (a wrong-kind URL redirects and breaks the topbar back button).
      const offlineType = this.isOfflinePlayback
        ? this.dlCache
            .load()
            .find((t) => t.mediaFileId === this.mediaFileId && t.status === 'ready')
            ?.media?.type
        : undefined;
      const kind = (this.media?.type ?? offlineType) === 'series' ? 'series' : 'movies';
      if (this.episodeId && kind === 'series') {
        // A finished episode returns to the NEXT episode's detail page so the
        // user lands ready to continue; an episode left mid-watch returns to
        // its own page (to resume).
        const next = this.nextEpisodeContext();
        const epId =
          this.episodeFinished() && next ? next.episodeId : this.episodeId;
        target = `/series/${this.mediaId}/episode/${epId}`;
      } else {
        target = `/${kind}/${this.mediaId}`;
      }
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
   * controls are visible, bumps the bottom margin by 10vh so cues don't sit
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
            label: formatAudioLabel(a, this.translate, i + 1),
            menuHead: formatAudioParts(a, this.translate, i + 1).head,
            menuSub: formatAudioParts(a, this.translate, i + 1).sub,
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
        label: audioList[i] ? formatAudioLabel(audioList[i], this.translate, i + 1) : t.label,
        menuHead: audioList[i] ? formatAudioParts(audioList[i], this.translate, i + 1).head : t.label,
        menuSub: audioList[i] ? formatAudioParts(audioList[i], this.translate, i + 1).sub : '',
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

    // si-* tracks are the streamInfo fallback list shown before the engine
    // surfaces client-switchable tracks. For HLS the transient si-* list
    // upgrades to shaka-* once Shaka fires trackschanged, and a shaka-* pick
    // switches client-side. But a si-* pick means there is no engine-level
    // track for that rendition yet, so the only way to honour it — in direct,
    // remux or transcode alike — is a backend reload that marks the new
    // audioStreamIndex DEFAULT (set above from the si-* index). Offline: no
    // backend, nothing to reload.
    if (this.isOfflinePlayback) return;
    if (!trackId.startsWith('si-')) return;
    await this.reloadStream();
  }

  /** Sort key mirroring the manifest's SUBTITLES order: embedded renditions
   *  first (by stream index), then external files (by DB id). Lets the ordinal
   *  below line up with the engine's own text-track order. */
  private subtitleManifestRank(s: SubtitleOption): number {
    if (s.id.startsWith('emb-')) return Number(s.id.slice(4)) || 0;
    return 1_000_000 + (s.subtitleDbId ?? 0);
  }

  /** 0-based ordinal of a soft subtitle among the tracks that share its
   *  (language, forced) — several same-language subs can't be told apart by
   *  language alone, so the engines pick the Nth one. */
  private subtitleOrdinal(sub: SubtitleOption): number {
    const peers = this.availableSubtitles()
      .filter(
        (s) =>
          !s.isImage &&
          !s.burnIn &&
          s.language === sub.language &&
          !!s.forced === !!sub.forced,
      )
      .sort((a, b) => this.subtitleManifestRank(a) - this.subtitleManifestRank(b));
    const idx = peers.findIndex((s) => s.id === sub.id);
    return idx < 0 ? 0 : idx;
  }

  async selectSubtitle(sub: SubtitleOption | null) {
    if (!this.engine) return;
    this.resetHideTimer();

    if (!sub) {
      try { this.engine.setTextVisibility(false); } catch {}
      this.activeSubtitleId.set(null);
      this.subtitlePickerOpen.set(false);
      this.trackManager.saveSubtitleSelection(this.mediaId, null);
      if (!this.isOfflinePlayback && this.activeBurnInId) {
        this.activeBurnInId = null;
        await this.reloadStream();
      }
      return;
    }

    // `burnIn` is already device-gated by the track manager: it's only true
    // when the engine can't render bitmap subs itself. Engines that can
    // (ExoPlayer, mpv) get burnIn=false and render the image track natively via
    // the select path below; the rest burn it into the video (transcode reload).
    if (sub.burnIn && sub.subtitleDbId) {
      this.activeBurnInId = sub.subtitleDbId;
      this.activeSubtitleId.set(sub.id);
      this.subtitlePickerOpen.set(false);
      // Persist like the soft/off branches do, so a burn-in pick is restored
      // on reload / next episode instead of silently reverting.
      this.trackManager.saveSubtitleSelection(
        this.mediaId,
        sub.language,
        sub.forced,
        sub.id.startsWith('emb-'),
        true,
      );
      await this.reloadStream();
      return;
    }

    try {
      if (this.activeBurnInId) {
        this.activeBurnInId = null;
        if (!this.isOfflinePlayback) await this.reloadStream();
      }
      const track = await this.engine.addTextTrack(sub.url, sub.language, sub.label, sub.forced, this.subtitleOrdinal(sub));
      // Keep the engine track's own id intact: Shaka's selectTextTrack matches
      // the rendition by its numeric track id, so overriding it with the app's
      // `sub.id` made the selection a no-op (subtitles only appeared after a
      // quality switch, whose reload passes the raw track). Native/desktop/TV
      // engines key off language/forced/embIndex, not id, so this is a no-op
      // for them — embIndex is still threaded through for desktop embedded subs.
      this.engine.selectTextTrack({
        ...track,
        embIndex: sub.id.startsWith('emb-') ? Number(sub.id.slice(4)) : null,
        image: sub.isImage,
      });
      try { this.engine.setTextVisibility(true); } catch {}
    } catch (e) {
      // Surface the failure instead of silently moving the checkmark to a track
      // that never loaded — leave the prior selection and the picker in place so
      // the user can pick another.
      console.error('[Player] Failed to load subtitle:', e);
      this.toast.error(this.translate.instant('player.subtitle_load_failed'));
      return;
    }

    this.activeSubtitleId.set(sub.id);
    this.subtitlePickerOpen.set(false);

    this.trackManager.saveSubtitleSelection(this.mediaId, sub.language, sub.forced, sub.id.startsWith('emb-'), sub.isImage);
  }

  // Bound DOM handlers kept as stable references so ngOnDestroy can remove
  // them — inline closures would pin this route-scoped component per session.
  private onSeeked = () => {
    this.resetStallWatchdog();
    this.savePosition();
  };
  private spriteAbort?: AbortController;

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
    // Tizen reports 10009 with no reliable `e.key` on older firmware, so the
    // legacy code stays load-bearing; read it through a plain typed view to
    // keep clear of the lib.dom `keyCode` deprecation.
    const legacyKeyCode = (e as { keyCode: number }).keyCode;
    const isBackKey = legacyKeyCode === 10009 || e.key === 'XF86Back' || e.key === 'GoBack' || e.key === 'Escape';

    // A floating cue (skip-intro / next-episode) stays visible and actionable
    // even while the controls bar is hidden. So — unlike a hidden bar control —
    // a focused cue must receive its activation key directly rather than have
    // the press swallowed to merely wake the bar. The guards below honour this.
    const activeEl = document.activeElement as HTMLElement | null;
    const cueFocused = !!activeEl?.closest('.player-floating-cue');

    // Controls hidden + Left/Right: wake the bar, seek, and land focus on the
    // seekbar so the next presses scrub it — on every device (keyboard + TV
    // remote), matching the seekbar-focused scrub when the bar is already up.
    if (
      !this.controlsVisible() &&
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      this.showControls();
      this.onSeek(this.engine.currentTime + (e.key === 'ArrowLeft' ? -10 : 10));
      this.focusSeekbar();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // TV only: any other key while the bar is hidden just WAKES it — never
    // activates the invisible focused button (e.g. OK would hit the back arrow
    // and quit). A focused cue is exempt: it's visible, so OK should act on it.
    // The back key bubbles to app.ts so the user can still exit.
    if (!isBackKey && !cueFocused && !this.controlsVisible() && this.device.isTv()) {
      this.showControls();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // ArrowLeft/Right are claimed by the seekbar when it owns focus, and used
    // for D-pad navigation between controls otherwise. Skip them here unless
    // no control has focus (in which case keep the legacy "background" seek).
    const arrowSeekAllowed = !activeEl || activeEl === document.body;

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
          (cueFocused ||
            (this.controlsVisible() &&
              activeEl &&
              activeEl !== document.body &&
              activeEl.closest('app-player-controls')))
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
    // — so Return-on-TV looked stuck. A focused cue is likewise left
    // alone: acting on it shouldn't drag the whole bar onto the screen.
    if (!isBackKey && !cueFocused) this.showControls();
  };

  // ── Event handlers ──

  private onBeforeUnload = () => {
    this.fireAndForgetStopSessions();
  };

  private onPlayerBackEvent = () => {
    // Desktop: Escape leaves the native (SDL) compositor fullscreen first —
    // before closing the controls bar or exiting the player — matching the
    // universal "Escape exits fullscreen" convention.
    if (
      this.isDesktopNative &&
      this.engine instanceof DesktopEngine &&
      this.engine.fullscreen
    ) {
      this.engine.setFullscreen(false);
      return;
    }
    // TV remote Return and desktop Escape first close a visible controls bar,
    // then exit on the next press — back mirrors the on-screen close. (On
    // desktop this event only ever comes from Escape, a deliberate keyboard
    // press.) Phones and tablets get the direct exit: touch users dismiss the
    // controls by tapping the video surface, not via hardware back.
    if ((this.device.isTv() || this.device.isDesktop()) && this.controlsVisible()) {
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
    // Re-selecting the active rung is a no-op: selectQuality() short-circuits
    // internally, but reloadStream() would still kill + re-mint the session
    // (ffmpeg stop, playback-info, full engine.load) for zero change.
    if (id === this.activeQualityId()) {
      this.resetHideTimer();
      return;
    }
    const mode = this.playbackMode();
    // Picking a rung below source — or any rung while already on the HLS
    // ladder — re-negotiates playback: reloadStream() re-requests playback-info
    // with the chosen quality, the backend re-decides DirectPlay vs the
    // transcode ladder, and the engine swaps the raw file for the HLS master.
    // Staying on `original` while direct-playing needs no reload. When we WILL
    // reload, pass engine=null so we don't select a variant the reload throws
    // away (it re-applies the quality after load via applyQualityPreferenceAfterLoad).
    const willReload = mode !== 'direct' || id !== 'original';
    this.qualityManager.selectQuality(option, willReload ? null : this.engine, mode, false, true);
    if (willReload) {
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

  /** Guards against overlapping reloads: a user switch racing a recovery (or
   *  a second quick switch) must not run two getPlaybackInfo + load cycles at
   *  once — that races the engine and leaks a session. */
  private reloadingStream = false;
  /** Set once doReloadStream reaches a successful engine.load(). Lets the
   *  reloadStream catch tell a dead surface (failure before load) from a live
   *  one (a later throw over already-playing video). */
  private reloadReachedPlayback = false;

  /** Reload the stream (e.g. when toggling burn-in subtitles or switching
   *  audio). User-initiated, so re-arm the native recovery guard and serialise
   *  against any concurrent reload/recovery. */
  private async reloadStream() {
    if (!this.engine || this.reloadingStream) return;
    this.reloadingStream = true;
    this.reloadReachedPlayback = false;
    this.engine.resetRecoveryGuard();
    try {
      await this.doReloadStream();
    } catch (e) {
      // Mobile Capacitor tears its surface down before re-negotiating, and
      // desktop mpv's negotiation failure otherwise never reaches the user —
      // both need a terminal card. Tizen/Shaka/webOS keep their previous
      // source playing from buffer and self-heal via the 410 -> sessionExpired
      // recovery, and a throw after load() means video is already playing —
      // none of those three should card.
      console.error('[Player] reloadStream failed:', e);
      if (
        this.isNativeEngine() &&
        !this.isTizenEngine() &&
        !this.reloadReachedPlayback &&
        !this.destroyed &&
        !this.state.error()
      ) {
        const { source, code } = classifyPlaybackError(e);
        this.state.setError(
          this.translate.instant(userMessageKeyFor({ source, code })),
          { source, code, message: (e as any)?.message ?? String(e) },
        );
      }
      throw e;
    } finally {
      this.reloadingStream = false;
    }
  }

  private async doReloadStream() {
    if (!this.engine) return;
    this.state.buffering.set(true);
    try {
      // A locked seekbar holds a target the engine hasn't converged on yet, so
      // anchor the reload there rather than at the engine's pre-seek position —
      // otherwise a switch made mid-seek restarts the stream where the user
      // just left, and the bar keeps showing the target it will never reach.
      const currentPos = this.state.seekLocked()
        ? this.currentTime()
        : this.engine.currentTime;
      // Capture the user's play/pause intent before tearing the stream down — a
      // quality / audio / subtitle switch must not resume a paused player.
      const wasPaused = this.paused();

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
      // Pass the requested rung so the backend re-decides DirectPlay vs the
      // transcode ladder: a rung below source forces the ladder, 'auto' lets the
      // server apply its autoQualityMode.
      const requestedQuality = this.resolveStartQuality();
      this.playbackInfo = await this.streamingApi.getPlaybackInfo(
        this.mediaFileId,
        deviceProfile,
        this.activeBurnInId ?? undefined,
        this.activeAudioStreamIndex,
        requestedQuality,
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
      // Refresh the near-expiry stream token before rebuilding the play URL:
      // it's baked into every segment URL and can't be swapped once the engine
      // loads, so a token that lapsed mid-film would 401 every segment.
      await this.authService.ensureStreamToken();
      const { url, mimeType } = this.buildPlayUrl({ startTime: currentPos });
      await this.engine.load(url, currentPos, mimeType);
      this.reloadReachedPlayback = true;

      this.qualityManager.applyQualityPreferenceAfterLoad(this.engine, mode);
      this.restorePlayState(wasPaused);

      // Restore active subtitle (non burn-in) after Shaka reload
      if (activeSub && !activeSub.burnIn && activeSub.url) {
        try {
          const track = await this.engine.addTextTrack(activeSub.url, activeSub.language, activeSub.label, activeSub.forced);
          this.engine.selectTextTrack(track);
          this.engine.setTextVisibility(true);
        } catch {}
      }
    } finally {
      this.state.buffering.set(false);
    }
  }

  private fireAndForgetStopSessions() {
    // Release this device's session on exit — DirectPlay included, so its
    // "now watching" dashboard row clears at once instead of lingering until
    // the backend idle reap (transcode/remux paths also stop their ffmpeg).
    if (!this.mediaFileId) return;
    const url = this.streamingApi.getStopSessionsUrl(
      this.mediaFileId,
      this.activeSessionId(),
    );
    fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  /** Get the currently active variant track. */
  private getActiveVariant(): any | null {
    return this.engine?.getVariantTracks()?.find((t: any) => t.active) ?? null;
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

    // Heartbeat even at position 0 — a player paused at the very start is
    // still live and the backend refreshes the LiveSession TTL off this PUT.
    // Only bail on a non-finite reading (engine not ready), never on 0.
    if (!Number.isFinite(pos)) return;

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
        const response = await this.streamingApi.updatePlaybackState(
          this.mediaId,
          payload,
        );
        // The backend has GC'd / lost our LiveSession (restart, long
        // idle, …). Re-issue playback-info and reload the engine
        // with the fresh sid at the current position before the
        // player's buffer drains.
        if (response?.sessionLost) {
          void this.recoverFromLostSession();
        }
        // Auto-delete-after-watched: the moment the server marks this item
        // completed, drop its auto-managed download (no-op otherwise).
        if (response?.state?.completed) {
          void this.autoDownload.onItemCompleted(this.mediaFileId);
        }
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
      container.style.setProperty('--cue-top-margin', `${s.subtitleTopMargin}vh`);
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
    this.spriteAbort = new AbortController();
    try {
      const url = this.streamingApi.getThumbnailMetadataUrl(this.mediaFileId);
      const res = await fetch(url, { signal: this.spriteAbort.signal });
      if (!res.ok) return;
      const meta: SpriteMetadata = await res.json();
      this.spriteMetadata.set(meta);
      this.spriteUrl.set(this.streamingApi.getThumbnailSpriteUrl(this.mediaFileId));
    } catch {
      // Sprite not available or aborted on teardown — tooltip shows time only
    }
  }

}
