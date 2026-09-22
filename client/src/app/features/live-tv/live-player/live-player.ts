import {
  Component,
  OnInit,
  OnDestroy,
  inject,
  signal,
  computed,
  effect,
  viewChild,
  ElementRef,
  DestroyRef,
  afterNextRender,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LiveTvApiService,
  OnNowEntry,
  PlaySession,
} from '../../../core/services/api/livetv-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { engineKindFor } from '../../../core/services/engine-traits';
import { ToastService } from '../../../core/services/toast.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { liveNeedsTs, supportsLiveDirectPlay } from './live-direct-play.util';
import { liveKeyAction } from './live-keymap';
import { PlaybackEngine } from '../../../core/services/playback-engine/playback-engine';
import {
  createEngineSurface,
  engineSurfaceKind,
  releaseEngineSurface,
} from '../../../core/services/playback-engine/engine-surface';
import {
  classifyPlaybackError,
  formatErrorDiagnostics,
  userMessageKeyFor,
  type PlaybackError,
} from '../../../core/services/playback-engine/playback-error';
import { LucideChevronUp, LucideChevronDown, LucideListVideo, LucideX } from '@lucide/angular';
import { PlayerControlsComponent } from '../../player/controls/player-controls';
import { DefaultFocusDirective } from '../../../shared/directives/default-focus.directive';
import { ControlsVisibilityService } from '../../player/controls/controls-visibility';
import { PlayerErrorOverlayComponent } from '../../player/overlay/player-error-overlay';
import {
  PlayerStatsOverlayComponent,
  type PlayerStats,
} from '../../player/overlay/player-stats-overlay';
import { programmeProgressPercent } from '../programme-progress';

/** Same native plugins as the VOD player (player.ts), duplicated rather than shared. */
interface ImmersivePlugin {
  enter(options?: { displayBehindNotch?: boolean }): Promise<void>;
  exit(): Promise<void>;
  setLightStatusBar(options: { light: boolean }): Promise<void>;
}
const Immersive = registerPlugin<ImmersivePlugin>('Immersive');

interface OrientationPlugin {
  lock(): Promise<void>;
  unlock(): Promise<void>;
}
const Orientation = registerPlugin<OrientationPlugin>('Orientation');

/** How far back a rewind press steps, inside the DVR window. */
const REWIND_STEP_SECONDS = 10;
/** Rewind below this reads as "at live": it is measured against the live point,
 *  not the manifest edge, so it needs no room for the player's own latency. */
const LIVE_EDGE_TOLERANCE_SECONDS = 1;
/** A full 500-channel page each tick, so this stays minutes apart, not seconds;
 *  the mini guide forces its own refresh when opened. */
const CHANNEL_REFRESH_MS = 120_000;
const NUMBER_ENTRY_COMMIT_MS = 1_500;
/** Channel up and down walk the whole lineup, not one screen of it. */
const ZAP_LIST_PAGE_SIZE = 500;

/** Playhead-to-clock drift that means the timeline was rebased, not merely that
 *  the manifest has yet to refresh. Well above one refresh interval. */
const CLOCK_RESYNC_MS = 30_000;

@Component({
  selector: 'app-live-player',
  imports: [TranslatePipe, PlayerControlsComponent, PlayerStatsOverlayComponent, PlayerErrorOverlayComponent, DefaultFocusDirective, LucideChevronUp, LucideChevronDown, LucideListVideo, LucideX],
  templateUrl: './live-player.html',
  providers: [ControlsVisibilityService],
})
export class LivePlayerComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(LiveTvApiService);
  private readonly device = inject(DeviceService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  /** Same owner as the VOD player: auto-hide, pins, blur, cursor. */
  readonly chrome = inject(ControlsVisibilityService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly containerEl = viewChild<ElementRef<HTMLElement>>('container');
  private readonly miniGuideEl = viewChild<ElementRef<HTMLElement>>('miniGuide');
  private readonly controlsCmp = viewChild(PlayerControlsComponent);
  private readonly guideBtn = viewChild<ElementRef<HTMLButtonElement>>('guideBtn');

  private engine: PlaybackEngine | null = null;
  readonly isDesktopNative = this.device.desktopPlatform() === 'electron';
  /** Drives the `directPlay` flag on `POST .../play`, see {@link supportsLiveDirectPlay}. */
  private readonly engineKind = engineKindFor(
    this.device.tvPlatform(),
    this.serverConfig.isNative,
    this.isDesktopNative,
  );
  private readonly isIosNative = Capacitor.getPlatform() === 'ios';
  /** Orientation.lock() (native iOS) has no Android counterpart — same gate as player.ts. */
  readonly canLockOrientation = this.isIosNative;
  readonly orientationLocked = signal(false);
  private readonly isLandscape = signal(screen.orientation?.type?.startsWith('landscape') ?? false);
  private readonly surfaceKind = engineSurfaceKind({
    tvPlatform: this.device.tvPlatform(),
    isDesktopNative: this.device.desktopPlatform() === 'electron',
  });
  /** Transparent only once the decoder owns a plane behind the page. Before
   *  that the black backdrop covers what the page would otherwise show through. */
  readonly nativeSurfaceClaimed = signal(false);

  readonly session = signal<PlaySession | null>(null);
  readonly channels = signal<OnNowEntry[]>([]);
  readonly currentChannelId = signal<number>(Number(this.route.snapshot.paramMap.get('channelId')));
  readonly loading = signal(true);
  readonly paused = signal(false);
  readonly liveEdgeReached = signal(true);
  readonly miniGuideOpen = signal(false);
  /** The panel is mounted off-screen, so animating that first placement shows it
   *  sliding out as the player opens. Armed once it is already there. */
  readonly guideAnimates = signal(false);
  private readonly armGuideAnimation = afterNextRender(() => this.guideAnimates.set(true));
  readonly numberBuffer = signal('');
  readonly volume = signal(1);
  readonly muted = signal(false);
  /** How far the playhead sits behind the live edge, in seconds. The one thing
   *  the engine can tell us that means anything on a stream with no duration. */
  private readonly behindLive = signal(0);
  readonly behindLiveSeconds = this.behindLive.asReadonly();
  /** What the retained window allows rewinding by, in seconds. */
  private readonly rewindable = signal(0);
  readonly rewindableSeconds = this.rewindable.asReadonly();
  /** Presentation time of the live edge, for mapping a seek back to the engine. */
  private readonly liveEdge = signal(0);

  /** The bar is anchored to the wall clock, so the clock has to be a signal:
   *  a `computed` reading `Date.now()` would keep its tune-in value forever. */
  private readonly now = signal(Date.now());

  /**
   * Wall-clock instant the playhead is showing. `seekRange.end` only moves when
   * the manifest refreshes, so `now - (edge - position)` gains a second per
   * second between refreshes and jumps back on each one. The playhead itself
   * runs smoothly, so it carries the time; the clock is only re-anchored when
   * the two genuinely diverge, which a refresh never does.
   */
  private readonly playheadWall = signal(0);
  private clockAnchor: { position: number; wall: number } | null = null;
  /** A live player sits a few segments behind the manifest edge and never
   *  catches up, so that distance is not a delay the viewer chose. The smallest
   *  one seen is the live point; anything beyond it is deliberate rewind. */
  private baselineLatencyMs = Number.POSITIVE_INFINITY;
  /** Distance from the manifest edge. Seek targets are expressed against it,
   *  unlike `behindLive`, which is what the viewer chose to rewind. */
  private readonly behindEdge = signal(0);

  /** A playback failure after the session opened. Nothing surfaced these
   *  before: the bar kept ticking over a black screen with no explanation. */
  readonly playbackError = signal<PlaybackError | null>(null);

  readonly statsVisible = signal(false);
  /** Engine stats are pulled, not pushed, so the panel needs its own tick. */
  private readonly statsTick = signal(0);
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  /** The programme the bar represents. Null on a channel with no guide, where
   *  the bar falls back to the retained window. */
  private readonly programmeSpan = computed(() => {
    const now = this.currentEntry()?.now;
    if (!now) return null;
    const start = new Date(now.startsAt).getTime();
    const end = new Date(now.endsAt).getTime();
    return end > start ? { start, end } : null;
  });

  /**
   * The seekbar reads as the current programme, because that is what a viewer
   * is watching: "22 minutes into a 52 minute episode", not a position inside a
   * rolling buffer. Without a guide it falls back to the window the session
   * advertises, a fixed scale: the amount retained so far is a moving target,
   * and a bar whose total grows under the playhead reads as a runaway clock.
   */
  readonly dvrWindow = computed(() => {
    const span = this.programmeSpan();
    if (!span) return this.session()?.dvrWindowSeconds ?? 0;
    return Math.round((span.end - span.start) / 1000);
  });

  /** Where the live edge sits on the bar: everything past it is future
   *  programme, not buffered content. */
  readonly liveBarPosition = computed(() => {
    const span = this.programmeSpan();
    if (!span) return this.dvrWindow();
    return Math.min(this.dvrWindow(), Math.max(0, Math.round((this.now() - span.start) / 1000)));
  });

  /** Earliest position on the bar a seek can land on: everything before it has
   *  rolled out of the retained window, or predates the moment we tuned in. */
  readonly seekableStart = computed(() => {
    const span = this.programmeSpan();
    if (!span) return Math.max(0, this.dvrWindow() - this.rewindable());
    return Math.max(0, this.liveBarPosition() - this.rewindable());
  });

  readonly dvrPosition = computed(() => {
    const span = this.programmeSpan();
    // Same anchored clock without a guide, or the readout sawtooths there too.
    if (!span) {
      const behind = Math.max(0, (this.now() - this.playheadWall()) / 1000);
      return Math.max(0, Math.round(this.dvrWindow() - behind));
    }
    const elapsed = (this.playheadWall() - span.start) / 1000;
    return Math.min(this.dvrWindow(), Math.max(0, Math.round(elapsed)));
  });

  readonly isNative = this.serverConfig.isNative;
  readonly pipAvailable = computed(() => !this.device.isTv() && !this.serverConfig.isNative);

  // Immersive mode: landscape=always, portrait=only while playing with controls hidden.
  private readonly immersiveEffect = effect(() => {
    if (!this.isNative) return;
    const shouldBeImmersive = this.isLandscape() || (!this.paused() && !this.chrome.visible());
    if (shouldBeImmersive) {
      Immersive.enter({ displayBehindNotch: true }).catch(() => {});
      document.body.classList.add('immersive');
    } else {
      Immersive.exit().catch(() => {});
      document.body.classList.remove('immersive');
      Immersive.setLightStatusBar({ light: false }).catch(() => {});
    }
  });

  readonly currentEntry = computed<OnNowEntry | null>(
    () => this.channels().find((e) => e.channel.id === this.currentChannelId()) ?? null,
  );
  readonly sortedChannels = computed(() =>
    [...this.channels()].sort((a, b) => a.channel.number - b.channel.number),
  );
  readonly channelTitle = computed(() => this.currentEntry()?.channel.name ?? '');
  readonly channelLogo = computed(() => this.currentEntry()?.channel.logoPath ?? null);
  readonly programTitle = computed(() => this.currentEntry()?.now?.title ?? '');

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private numberBufferTimer: ReturnType<typeof setTimeout> | null = null;
  private miniGuideScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private tuneSeq = 0;
  /** Mirrors `session()?.sessionId`, but a concurrent `tune()` never nulls it
   *  early, so the next call can still find and stop the session it replaces. */
  private currentSessionId: string | null = null;

  ngOnInit(): void {
    window.addEventListener('keydown', this.onKeydownCapture, true);
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = Number(params.get('channelId'));
      if (!id || id === this.currentChannelId()) return;
      void this.tune(id);
    });
    this.chrome.configure({
      pinned: computed(() => this.paused() || this.loading() || this.miniGuideOpen()),
      surfaceSelector: 'app-player-controls, .live-player-strip',
    });
    void this.bootstrap();
    window.addEventListener('pagehide', this.releaseOnUnload);
    window.addEventListener('app:playerBack', this.onPlayerBackEvent);
    this.refreshTimer = setInterval(() => void this.refreshChannels(), CHANNEL_REFRESH_MS);
    if (this.isNative) {
      screen.orientation?.addEventListener('change', this.onOrientationChange);
    }
  }

  private readonly onOrientationChange = (): void => {
    this.isLandscape.set(screen.orientation?.type?.startsWith('landscape') ?? false);
  };

  onToggleOrientationLock(): void {
    const locked = !this.orientationLocked();
    this.orientationLocked.set(locked);
    (locked ? Orientation.lock() : Orientation.unlock()).catch(() => {});
  }

  /** Hardware back and desktop Escape reach every player through app.ts, which
   *  routes anything under /watch here rather than popping the history itself.
   *  Same ladder as on-demand playback: the panel, then the bar, then out. */
  private readonly onPlayerBackEvent = (): void => {
    if (this.miniGuideOpen()) {
      this.closeMiniGuide();
      return;
    }
    if ((this.device.isTv() || this.device.isDesktop()) && this.chrome.visible()) {
      this.chrome.hide();
      return;
    }
    this.goBack();
  };

  /** The browser gives no async time on a tab close, so the release goes out
   *  through a keepalive request rather than the Angular client. */
  private readonly releaseOnUnload = (): void => {
    const id = this.currentSessionId ?? this.session()?.sessionId;
    if (id) this.api.stopSessionOnUnload(id);
  };

  ngOnDestroy(): void {
    // Supersede any in-flight tune(): its late session must release itself,
    // not land in a destroyed engine.
    this.tuneSeq++;
    window.removeEventListener('keydown', this.onKeydownCapture, true);
    window.removeEventListener('pagehide', this.releaseOnUnload);
    window.removeEventListener('app:playerBack', this.onPlayerBackEvent);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.numberBufferTimer) clearTimeout(this.numberBufferTimer);
    if (this.miniGuideScrollTimer) clearTimeout(this.miniGuideScrollTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    void this.teardownSession();
    void this.engine?.destroy();
    releaseEngineSurface();
    if (this.isNative) {
      screen.orientation?.removeEventListener('change', this.onOrientationChange);
      if (this.isIosNative) Orientation.unlock().catch(() => {});
      Immersive.exit().catch(() => {});
      document.body.classList.remove('immersive');
    }
  }

  private async bootstrap(): Promise<void> {
    // The zap list's now/next payload is only for the overlay; video start
    // shouldn't wait behind it on a slow connection.
    await Promise.all([this.tune(this.currentChannelId()), this.refreshChannels()]);
  }

  private async refreshChannels(): Promise<void> {
    try {
      // The zap list needs every channel, so it asks for one large page rather
      // than the default the On now grid uses.
      const answer = await this.api.getOnNow({ pageSize: ZAP_LIST_PAGE_SIZE });
      this.channels.set(answer.entries);
    } catch {
      // keep the last known list; the overlay just goes a bit stale
    }
  }

  private async tune(channelId: number): Promise<void> {
    // A zap fired while a previous one is still awaiting release/play must not
    // let a late resolution overwrite a more recent one's session or engine load.
    const seq = ++this.tuneSeq;
    this.loading.set(true);
    // The next channel brings its own timeline; carrying the mapping over would
    // show the previous one's clock until the drift check caught up.
    this.playbackError.set(null);
    this.clockAnchor = null;
    this.baselineLatencyMs = Number.POSITIVE_INFINITY;
    // Read from a field, not `this.session()`: a concurrent call may already
    // have nulled the signal, which would hide the session this one must stop.
    const outgoingSessionId = this.currentSessionId;
    this.currentChannelId.set(channelId);
    // Released before tuning, not after: a subscription capped at one connection
    // answers 409 to every zap while the outgoing channel still holds the slot.
    if (outgoingSessionId) {
      this.session.set(null);
      await this.api.stopSession(outgoingSessionId).catch(() => {});
      this.currentSessionId = null;
      if (seq !== this.tuneSeq) return;
    }
    try {
      const session = await this.api.play(channelId, {
        directPlay: supportsLiveDirectPlay(this.engineKind, this.isIosNative),
        useTs: liveNeedsTs(this.engineKind),
      });
      if (seq !== this.tuneSeq) {
        // A later zap already won; don't leak this session or fight over the engine.
        void this.api.stopSession(session.sessionId).catch(() => {});
        return;
      }
      this.currentSessionId = session.sessionId;
      this.session.set(session);
      await this.loadIntoEngine(session);
      if (seq !== this.tuneSeq) return;
      this.liveEdgeReached.set(true);
    } catch (err) {
      if (seq === this.tuneSeq) this.handlePlayError(err);
      return;
    } finally {
      if (seq === this.tuneSeq) this.loading.set(false);
    }
  }

  /** Only a channel that genuinely can't be played (gone, or out of reach)
   *  sends the viewer back; everything else — capacity, a transient 5xx, a
   *  timeout — surfaces on the retry overlay instead, same as an engine error. */
  private handlePlayError(err: unknown): void {
    if (err instanceof HttpErrorResponse && (err.status === 404 || err.status === 403)) {
      this.toast.error(this.translate.instant('liveTv.error_play_failed'));
      void this.router.navigate(['/live-tv'], { state: { rootEntry: true } });
      return;
    }
    const body =
      err instanceof HttpErrorResponse
        ? (err.error as { code?: string; sourceName?: string; limit?: number } | null)
        : null;
    const userMessage =
      err instanceof HttpErrorResponse && err.status === 409 && body?.code === 'livetv_source_at_capacity'
        ? this.translate.instant('liveTv.error_at_capacity', {
            sourceName: body.sourceName ?? '',
            limit: body.limit ?? 0,
          })
        : body?.code === 'livetv_account_expired'
          ? this.translate.instant('liveTv.error_account_expired', { sourceName: body.sourceName ?? '' })
          : this.translate.instant('liveTv.error_play_failed');
    const { source, code } = classifyPlaybackError(err);
    this.playbackError.set({ userMessage, source, code });
  }

  private async ensureEngine(): Promise<PlaybackEngine> {
    if (this.engine) return this.engine;
    const surface = await createEngineSurface({
      kind: this.surfaceKind,
      video: this.videoEl()!.nativeElement,
      container: this.containerEl()?.nativeElement,
    });
    const engine = surface.engine;
    this.nativeSurfaceClaimed.set(surface.usesNativeSurface);
    engine.on('error', (e) => {
      // Same taxonomy and same panel as on-demand playback.
      const source = e.source ?? 'engine';
      this.playbackError.set({
        userMessage: this.translate.instant(
          e.errorKey ?? userMessageKeyFor({ source, code: e.code, category: e.category }),
        ),
        source,
        code: e.code,
        category: e.category,
        severity: e.severity,
        data: e.data,
        variant: e.variant,
        message: e.message,
      });
      this.loading.set(false);
    });
    engine.on('stateChanged', ({ state }) => this.paused.set(state === 'paused'));
    engine.on('volumechange', ({ volume, muted }) => {
      this.volume.set(volume);
      this.muted.set(muted);
    });
    engine.on('timeUpdate', ({ position }) => {
      // The seekable range, not `buffered`: on a live stream the buffer ends a
      // few seconds ahead of the playhead, so seeking against it lands outside
      // the window and the player snaps back to the edge.
      this.now.set(Date.now());
      const { start, end } = engine.seekRange;
      const edge = Math.max(end, position);
      this.liveEdge.set(edge);
      this.rewindable.set(
        Math.min(Math.max(0, edge - start), this.session()?.dvrWindowSeconds ?? 0),
      );
      const fromEdge = Math.max(0, edge - position);
      this.behindEdge.set(fromEdge);
      this.trackPlayheadClock(position, fromEdge);
    });
    this.engine = engine;
    return engine;
  }

  errorDiagnostics(): string {
    const err = this.playbackError();
    if (!err) return '';
    return formatErrorDiagnostics(err, {
      mode: this.session()?.mode,
      engine: this.engineKind,
      url: this.session()?.url,
    });
  }

  retryPlayback(): void {
    this.playbackError.set(null);
    void this.tune(this.currentChannelId());
  }

  private async loadIntoEngine(session: PlaySession): Promise<void> {
    const engine = await this.ensureEngine();
    // Direct play hands the engine the provider's raw transport stream, not a manifest.
    const mimeType =
      session.mode === 'direct' ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
    // The session URL is origin-relative. A native engine is not a browser and
    // has no origin: ExoPlayer read it as a local file path and failed on ENOENT.
    await engine.load(this.serverConfig.resolveUrl(session.url), undefined, mimeType);
    await engine.play();
  }

  // ── Transport ──

  togglePlay(): void {
    if (!this.engine) return;
    if (this.engine.paused) void this.engine.play();
    else void this.engine.pause();
  }

  /** `seconds` is a position on the bar, so in the programme when there is one. */
  onSeek(seconds: number): void {
    const engine = this.engine;
    if (!engine) return;
    // Seeking is expressed against the manifest edge; how far behind live that
    // leaves the viewer is the clock tracker's to say, on the next tick.
    void engine.seek(this.liveEdge() - this.behindLiveForBarPosition(seconds));
  }

  /**
   * Bar position to seconds behind the live edge, clamped to what the window
   * actually retains: the bar can show a whole programme while only its tail is
   * still on disk, and a seek into the missing part would stall the player.
   */
  private behindLiveForBarPosition(seconds: number): number {
    const span = this.programmeSpan();
    const wanted = span
      ? (Date.now() - (span.start + seconds * 1000)) / 1000
      : this.dvrWindow() - seconds;
    return Math.min(this.rewindable(), Math.max(0, wanted));
  }

  onVolumeChange(value: number): void {
    if (this.engine) this.engine.volume = value;
  }

  onToggleMute(): void {
    if (this.engine) this.engine.muted = !this.engine.muted;
  }

  onToggleFullscreen(): void {
    const el = this.containerEl()?.nativeElement;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  }

  onTogglePip(): void {
    const video = this.videoEl()?.nativeElement;
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void video.requestPictureInPicture?.();
  }

  async rewind(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const behind = Math.min(this.rewindable(), this.behindEdge() + REWIND_STEP_SECONDS);
    await engine.seek(this.liveEdge() - behind);
    this.liveEdgeReached.set(false);
  }

  async backToLive(): Promise<void> {
    if (!this.engine) return;
    await this.engine.seek(this.liveEdge());
    this.liveEdgeReached.set(true);
  }

  channelUp(): void {
    this.zapBy(1);
  }

  channelDown(): void {
    this.zapBy(-1);
  }

  private zapBy(direction: 1 | -1): void {
    const list = this.sortedChannels();
    if (list.length === 0) return;
    const idx = list.findIndex((e) => e.channel.id === this.currentChannelId());
    const nextIdx = (idx + direction + list.length) % list.length;
    void this.router.navigate(['/watch-live', list[nextIdx].channel.id]);
  }

  goBack(): void {
    void this.router.navigate(['/live-tv'], { state: { rootEntry: true } });
  }

  toggleMiniGuide(): void {
    if (this.miniGuideOpen()) {
      this.closeMiniGuide();
      return;
    }
    this.miniGuideOpen.set(true);
    this.chrome.show();
    void this.refreshChannels();
    if (this.miniGuideScrollTimer) clearTimeout(this.miniGuideScrollTimer);
    // A hundred channels in: open on the one being watched, not on the top.
    this.miniGuideScrollTimer = setTimeout(() => {
      this.miniGuideScrollTimer = null;
      const row = this.miniGuideEl()?.nativeElement.querySelector(
        `[data-channel-id="${this.currentChannelId()}"]`,
      );
      row?.scrollIntoView({ block: 'center' });
      (row?.querySelector('button') as HTMLElement | null)?.focus();
    });
  }

  /** The panel goes inert on close, so focus has to leave it or the next
   *  D-pad press starts from an element no one can see. */
  private closeMiniGuide(): void {
    if (this.miniGuideScrollTimer) {
      clearTimeout(this.miniGuideScrollTimer);
      this.miniGuideScrollTimer = null;
    }
    this.miniGuideOpen.set(false);
    const inPanel = document.activeElement?.closest('[data-channel-id]');
    if (inPanel) this.guideBtn()?.nativeElement.focus({ preventScroll: true });
  }

  selectFromMiniGuide(entry: OnNowEntry): void {
    this.closeMiniGuide();
    if (entry.channel.id !== this.currentChannelId()) void this.router.navigate(['/watch-live', entry.channel.id]);
  }

  // ── Overlay + remote/keyboard ──


  private readonly onKeydownCapture = (event: KeyboardEvent): void => this.onKeydown(event);

  onKeydown(event: KeyboardEvent): void {
    const action = liveKeyAction(event.key, {
      visible: this.chrome.visible(),
      guideOpen: this.miniGuideOpen(),
    });
    switch (action.kind) {
      case 'wake':
        event.preventDefault();
        event.stopPropagation();
        this.chrome.show();
        return;
      case 'zap':
        event.preventDefault();
        event.stopPropagation();
        this.zap(action.by);
        return;
      case 'scrub':
        event.preventDefault();
        this.chrome.show();
        // The seekbar owns the accelerating run, one deferred seek for the lot.
        this.controlsCmp()?.scrubFromKey(event);
        return;
      case 'digit':
        this.chrome.show();
        this.onDigit(action.digit);
        return;
      case 'commitNumber':
        // Enter with nothing typed belongs to whatever button holds focus.
        if (this.numberBuffer()) this.commitNumberBuffer();
        return;
      default:
        return;
    }
  }

  toggleStats(): void {
    const visible = !this.statsVisible();
    this.statsVisible.set(visible);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    if (!visible) return;
    this.statsTick.update((t) => t + 1);
    this.statsTimer = setInterval(() => this.statsTick.update((t) => t + 1), 1000);
  }

  readonly playerStats = computed<PlayerStats | null>(() => {
    if (!this.statsVisible()) return null;
    void this.statsTick();

    const session = this.session();
    const engineStats = this.engine?.getStats();
    const variant = engineStats?.activeVariant;
    const container = session?.mode === 'direct' ? 'mpeg-ts' : 'fmp4';

    const bitrate = (bps: number | undefined): string => {
      if (!bps || bps <= 0) return '';
      if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
      if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)} kbps`;
      return `${bps} bps`;
    };
    const seconds = (value: number): string => `${Math.round(value)}s`;

    const resolution =
      variant?.width && variant?.height ? `${variant.width}x${variant.height}` : '';
    const videoCodec = variant?.videoCodec ?? '';
    const audioCodec = variant?.audioCodec ?? '';

    return {
      container,
      containerBitrate: bitrate(engineStats?.streamBandwidth),
      outputFormat: '',
      outputFps: '',
      streamTypeKey: `player.stats_stream_type_${session?.mode ?? 'remux'}`,

      videoLabel: [resolution, videoCodec].filter(Boolean).join(' ') || videoCodec,
      videoStreamBitrate: bitrate(variant?.videoBandwidth),
      videoProfileLine: '',
      videoPlaybackMode: this.translate.instant(this.livePlaybackModeKey()),
      crop: '',
      tonemapping: '',
      videoTranscodeReasons: [],
      droppedFrames: engineStats?.droppedFrames ?? 0,

      audioLabel: audioCodec,
      audioStreamBitrate: bitrate(variant?.audioBandwidth),
      audioDetailLine: '',
      audioPlaybackMode: this.translate.instant(this.livePlaybackModeKey()),
      audioTranscodeReasons: [],

      live: {
        behindLive: seconds(this.behindLiveSeconds()),
        rewindWindow: seconds(this.rewindableSeconds()),
        segmentDuration: seconds(session?.segmentSeconds ?? 0),
      },
    };
  });

  /**
   * Keeps the playhead's wall clock. A seek moves `position`, so the mapping
   * still holds and needs no reset; only a rebased timeline (a respawn, a
   * discontinuity) drifts far enough to warrant re-anchoring.
   */
  private trackPlayheadClock(position: number, behind: number): void {
    const now = Date.now();
    const measured = now - behind * 1000;
    const anchor = this.clockAnchor;
    const predicted = anchor ? anchor.wall + (position - anchor.position) * 1000 : null;
    if (predicted === null || Math.abs(predicted - measured) > CLOCK_RESYNC_MS) {
      this.clockAnchor = { position, wall: measured };
      this.baselineLatencyMs = Number.POSITIVE_INFINITY;
      this.playheadWall.set(measured);
    } else {
      this.playheadWall.set(predicted);
    }

    const latency = now - this.playheadWall();
    this.baselineLatencyMs = Math.min(this.baselineLatencyMs, latency);
    const rewound = Math.max(0, (latency - this.baselineLatencyMs) / 1000);
    this.behindLive.set(rewound);
    this.liveEdgeReached.set(rewound < LIVE_EDGE_TOLERANCE_SECONDS);
  }

  /** Remux copies both bitstreams into HLS; only `transcode` re-encodes. */
  private livePlaybackModeKey(): string {
    return this.session()?.mode === 'transcode'
      ? 'player.stats_stream_type_transcode'
      : 'player.stats_direct_playback';
  }

  private zap(direction: 1 | -1): void {
    this.chrome.show();
    if (direction === 1) this.channelUp();
    else this.channelDown();
  }

  private onDigit(digit: string): void {
    this.numberBuffer.update((b) => (b + digit).slice(-3));
    if (this.numberBufferTimer) clearTimeout(this.numberBufferTimer);
    this.numberBufferTimer = setTimeout(() => this.commitNumberBuffer(), NUMBER_ENTRY_COMMIT_MS);
  }

  private commitNumberBuffer(): void {
    const buffer = this.numberBuffer();
    this.numberBuffer.set('');
    if (!buffer) return;
    const target = this.channels().find((e) => e.channel.number === Number(buffer));
    if (target) void this.router.navigate(['/watch-live', target.channel.id]);
  }

  private async teardownSession(): Promise<void> {
    const id = this.currentSessionId ?? this.session()?.sessionId;
    if (id) await this.api.stopSession(id).catch(() => {});
  }

  readonly progressPercent = programmeProgressPercent;
}
