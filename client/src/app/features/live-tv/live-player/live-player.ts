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
  untracked,
  Injector,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
  LiveTvApiService,
  LiveChannel,
  LiveProgram,
  OnNowEntry,
  PlaySession,
} from '../../../core/services/api/livetv-api.service';
import { DeviceService } from '../../../core/services/device.service';
import { ServerConfigService } from '../../../core/services/server-config.service';
import { engineKindFor } from '../../../core/services/engine-traits';
import { ToastService } from '../../../core/services/toast.service';
import { NetworkService } from '../../../core/services/network.service';
import { PlayerStateService } from '../../../core/services/player-state.service';
import { RecoveryController, type PlaybackFailure } from '../../player/recovery-controller';
import { SessionSyncService } from '../../../core/services/session-sync.service';
import { ResolveUrlPipe } from '../../../core/pipes/resolve-url.pipe';
import { CachedSrcDirective } from '../../../shared/directives/cached-src.directive';
import { liveNeedsTs, supportsLiveDirectPlay } from './live-direct-play.util';
import { LiveQoe } from './live-qoe';
import { QoeReporter } from '../../../core/services/qoe-reporter.service';
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
import { PlayerScreen } from '../../player/player-screen';
import { playerKeyAction, type MediaKeyAction } from '../../player/player-keymap';
import { PlayerSettingsService } from '../../../core/services/player-settings.service';
import { formatBitrate } from '../../../core/utils/format-bytes';

/** How far back a rewind press steps, inside the DVR window. */
const REWIND_STEP_SECONDS = 10;
/** Rewind below this reads as "at live": it is measured against the live point,
 *  not the manifest edge, so it needs no room for the player's own latency. */
const LIVE_EDGE_TOLERANCE_SECONDS = 1;
const NUMBER_ENTRY_COMMIT_MS = 1_500;
/** Page size of `on-now`, the backend's own `@Max`; row `i` of the lineup sits on page `floor(i / size) + 1`. */
const ON_NOW_PAGE_SIZE = 50;
/** A cached now/next page older than this is fetched again when the overlay shows it. */
const PAGE_STALE_MS = 60_000;
/** The playing channel's page is refreshed this often, or as soon as its programme ends. */
const CURRENT_PAGE_REFRESH_MS = 120_000;
/** The overlay renders its rows in steps of this many, one step above and below the scrollport. */
const WINDOW_STEP_ROWS = 8;
/** Height of an overlay row (`h-20`) plus its gap, until a rendered one is measured. */
const DEFAULT_ROW_PX = 84;

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
  private readonly sessionSync = inject(SessionSyncService);
  /** Live TV claims no account session but is playing: it keeps the strip and an observed owner off this device. */
  private readonly unregisterSession = this.sessionSync.registerPlayer({
    sessionId: () => undefined,
    active: () => true,
    yield: async () => {},
  });
  /** Same owner as the VOD player: auto-hide, pins, cursor. */
  readonly chrome = inject(ControlsVisibilityService);

  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly containerEl = viewChild<ElementRef<HTMLElement>>('container');
  private readonly miniGuideEl = viewChild<ElementRef<HTMLElement>>('miniGuide');
  private readonly controlsCmp = viewChild(PlayerControlsComponent);
  private readonly guideBtn = viewChild<ElementRef<HTMLButtonElement>>('guideBtn');

  private engine: PlaybackEngine | null = null;
  private readonly liveQoe = new LiveQoe(inject(QoeReporter), (id, qoe, state) => this.api.heartbeat(id, qoe, state));
  readonly isDesktopNative = this.device.desktopPlatform() === 'electron';
  private readonly isIosNative = Capacitor.getPlatform() === 'ios';
  /** Drives the `directPlay` flag on `POST .../play`, see {@link supportsLiveDirectPlay}. */
  private readonly engineKind = engineKindFor(
    this.device.tvPlatform(),
    this.serverConfig.isNative,
    this.isDesktopNative,
    this.isIosNative,
  );
  protected readonly screen = new PlayerScreen({
    native: this.serverConfig.isNative,
    landscapeOnOpen: !this.device.isTv() && inject(PlayerSettingsService).get().landscapeOnOpen,
    immersiveInPortrait: () => !this.paused() && !this.chrome.visible(),
  });
  private readonly surfaceKind = engineSurfaceKind({
    tvPlatform: this.device.tvPlatform(),
    isDesktopNative: this.device.desktopPlatform() === 'electron',
  });
  /** Transparent only once the decoder owns a plane behind the page. Before
   *  that the black backdrop covers what the page would otherwise show through. */
  readonly nativeSurfaceClaimed = signal(false);

  readonly session = signal<PlaySession | null>(null);
  readonly channels = signal<LiveChannel[]>([]);
  private readonly nowNext = signal(new Map<number, { now: LiveProgram | null; next: LiveProgram | null }>());
  /** When each `on-now` page was last merged into {@link nowNext}. */
  private pageFetchedAt = new Map<number, number>();
  private pagesInFlight = new Set<number>();
  /** Overlay rows in the DOM: only the window around the scrollport, the rest is spacer. */
  readonly windowFirst = signal(0);
  readonly windowSize = signal(4 * WINDOW_STEP_ROWS);
  readonly rowPx = signal(DEFAULT_ROW_PX);
  readonly windowRows = computed(() =>
    this.channels()
      .slice(this.windowFirst(), this.windowFirst() + this.windowSize())
      .map((channel) => ({ channel, ...this.nowNext().get(channel.id) })),
  );
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
  /** The level the video player keeps too: one volume for the user, saved across sessions. */
  private readonly level = inject(PlayerStateService).volume;
  readonly volume = this.level.asReadonly();
  readonly muted = signal(false);
  /** A retry is running (re-tune, backoff, waiting for the network): the spinner stays up. */
  readonly recovering = signal(false);
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

  /** Wall-clock instant the playhead shows. `seekRange.end` only moves on manifest refresh, so the playhead carries the time;
   *  the clock re-anchors only when the two genuinely diverge, which a refresh never does. */
  private readonly playheadWall = signal(0);
  private clockAnchor: { position: number; wall: number } | null = null;
  /** A live player sits a few segments behind the edge and never catches up: the smallest latency seen is the live point, beyond it is deliberate rewind. */
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

  /** Seekbar reads as the current programme; without a guide it uses the advertised window, a fixed scale (a growing total reads as a runaway clock). */
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

  readonly currentEntry = computed<OnNowEntry | null>(() => {
    const channel = this.channels().find((c) => c.id === this.currentChannelId());
    if (!channel) return null;
    return { channel, now: null, next: null, ...this.nowNext().get(channel.id) };
  });
  readonly channelTitle = computed(() => this.currentEntry()?.channel.name ?? '');
  readonly channelLogo = computed(() => this.currentEntry()?.channel.logoPath ?? null);
  readonly programTitle = computed(() => this.currentEntry()?.now?.title ?? '');

  private readonly network = inject(NetworkService);
  private readonly injector = inject(Injector);
  protected recovery = this.createRecovery();
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /** User zaps and tunes in flight: they own the session, recovery stands aside. */
  private zaps = 0;
  private numberBufferTimer: ReturnType<typeof setTimeout> | null = null;
  private miniGuideScrollTimer: ReturnType<typeof setTimeout> | null = null;
  private tuneSeq = 0;
  private channelsSeq = 0;
  private readonly miniListEl = viewChild<ElementRef<HTMLElement>>('miniList');
  /** Mirrors `session()?.sessionId`, but a concurrent `tune()` never nulls it
   *  early, so the next call can still find and stop the session it replaces. */
  private currentSessionId: string | null = null;
  /** Set once ngOnDestroy runs, so an engine created after that point is torn
   *  down instead of being adopted by a component nobody will clean up again. */
  private destroyed = false;
  private engineCreation: Promise<PlaybackEngine> | null = null;

  ngOnInit(): void {
    window.addEventListener('keydown', this.onKeydownCapture, true);
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = Number(params.get('channelId'));
      if (!id || id === this.currentChannelId()) return;
      void this.tune(id);
    });
    this.chrome.configure({
      pinned: computed(() => this.paused() || this.loading() || this.miniGuideOpen()),
    });
    void this.bootstrap();
    window.addEventListener('pagehide', this.releaseOnUnload);
    if (this.isHideSuspendedTv) document.addEventListener('visibilitychange', this.onTvVisibility);
    window.addEventListener('app:playerBack', this.onPlayerBackEvent);
    this.recovery.armClock();
    this.watchTimer = setInterval(() => {
      this.recovery.tickClockWatch();
      this.recovery.checkStall();
      this.refreshCurrentPageIfDue();
    }, 1000);
    this.screen.open();
  }

  /** Hardware back and desktop Escape arrive via app.ts for anything under /watch; same ladder as on-demand: panel, bar, out. */
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
    this.liveQoe.end(true);
    if (id) this.api.stopSessionOnUnload(id);
  };

  /** Tizen and webOS freeze JS while hidden, so heartbeats stop and the server reaps the session. */
  private readonly isHideSuspendedTv = this.device.tvPlatform() === 'tizen' || this.device.tvPlatform() === 'webos';

  /** Home, input switch and standby hide the app without unloading it: release the viewer, re-tune on return. */
  private readonly onTvVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.tuneSeq++;
      void this.engine?.pause();
      this.releaseOnUnload();
      this.currentSessionId = null;
      this.session.set(null);
    } else if (!this.destroyed && !this.currentSessionId) {
      void this.tune(this.currentChannelId());
    }
  };

  ngOnDestroy(): void {
    // Supersede any in-flight tune(): its late session must release itself,
    // not land in a destroyed engine.
    this.tuneSeq++;
    this.destroyed = true;
    this.unregisterSession();
    window.removeEventListener('keydown', this.onKeydownCapture, true);
    window.removeEventListener('pagehide', this.releaseOnUnload);
    document.removeEventListener('visibilitychange', this.onTvVisibility);
    window.removeEventListener('app:playerBack', this.onPlayerBackEvent);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.recovery.dispose();
    if (this.numberBufferTimer) clearTimeout(this.numberBufferTimer);
    if (this.miniGuideScrollTimer) clearTimeout(this.miniGuideScrollTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    void this.teardownSession();
    void this.engine?.destroy();
    releaseEngineSurface();
    this.screen.close();
  }

  private async bootstrap(): Promise<void> {
    // The lineup is only for zapping and the overlay; video start shouldn't wait behind it.
    await Promise.all([this.tune(this.currentChannelId()), this.loadChannels()]);
    void this.fetchPage(this.currentPage(), true);
  }

  private async loadChannels(): Promise<void> {
    const seq = ++this.channelsSeq;
    try {
      const list = await this.api.getChannels();
      if (seq !== this.channelsSeq) return;
      const sameLineup = list.length === this.channels().length && list.every((c, i) => c.id === this.channels()[i].id);
      if (!sameLineup) this.pageFetchedAt.clear();
      this.channels.set(list);
    } catch {
      // keep the last known list; the overlay just goes a bit stale
    }
  }

  /** The `on-now` page holding the playing channel, 0 until the lineup is known. */
  private currentPage(): number {
    const idx = this.channels().findIndex((c) => c.id === this.currentChannelId());
    return idx < 0 ? 0 : Math.floor(idx / ON_NOW_PAGE_SIZE) + 1;
  }

  /** Merges one `on-now` page into the now/next map; skipped while fresh unless `force`. */
  private async fetchPage(page: number, force = false): Promise<void> {
    if (page < 1 || this.pagesInFlight.has(page)) return;
    const at = this.pageFetchedAt.get(page);
    if (!force && at !== undefined && Date.now() - at < PAGE_STALE_MS) return;
    this.pagesInFlight.add(page);
    try {
      const answer = await this.api.getOnNow({ page, pageSize: ON_NOW_PAGE_SIZE });
      const merged = new Map(this.nowNext());
      for (const e of answer.entries) merged.set(e.channel.id, { now: e.now, next: e.next });
      this.nowNext.set(merged);
      this.pageFetchedAt.set(page, Date.now());
    } catch {
      // the rows keep their last now/next
    } finally {
      this.pagesInFlight.delete(page);
    }
  }

  private refreshCurrentPageIfDue(): void {
    const page = this.currentPage();
    const at = this.pageFetchedAt.get(page);
    if (at === undefined) return;
    const age = Date.now() - at;
    const ended = this.currentEntry()?.now && new Date(this.currentEntry()!.now!.endsAt).getTime() <= Date.now();
    if (age >= CURRENT_PAGE_REFRESH_MS || (ended && age >= 10_000)) void this.fetchPage(page, true);
  }

  /** Fetches now/next for the pages the rendered overlay rows sit on. */
  private readonly windowPagesEffect = effect(() => {
    if (!this.miniGuideOpen()) return;
    const first = this.windowFirst();
    const last = Math.min(first + this.windowSize(), this.channels().length) - 1;
    if (last < first) return;
    untracked(() => {
      for (let p = Math.floor(first / ON_NOW_PAGE_SIZE) + 1; p <= Math.floor(last / ON_NOW_PAGE_SIZE) + 1; p++) {
        void this.fetchPage(p);
      }
    });
  });

  /** Moves the rendered rows to the scroll offset, in whole steps so a scroll re-renders once per step. */
  updateWindow(el: HTMLElement): void {
    const li = el.querySelector<HTMLElement>('[data-channel-id]');
    if (li) {
      const gap = parseFloat(getComputedStyle(li.parentElement!).rowGap) || 0;
      const stride = li.getBoundingClientRect().height + gap;
      if (stride !== this.rowPx()) this.rowPx.set(stride);
    }
    const rowPx = this.rowPx();
    const step = Math.floor(el.scrollTop / rowPx / WINDOW_STEP_ROWS);
    this.windowFirst.set(Math.max(0, (step - 1) * WINDOW_STEP_ROWS));
    this.windowSize.set((Math.ceil(el.clientHeight / rowPx / WINDOW_STEP_ROWS) + 3) * WINDOW_STEP_ROWS);
  }

  /** A passive listener, not a template binding: only a window step re-renders the overlay. */
  private readonly windowEffect = effect((onCleanup) => {
    const el = this.miniListEl()?.nativeElement;
    if (!el) return;
    let raf: number | null = null;
    const onScroll = () => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        this.updateWindow(el);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    untracked(() => this.updateWindow(el));
    onCleanup(() => {
      el.removeEventListener('scroll', onScroll);
      if (raf !== null) cancelAnimationFrame(raf);
    });
  });

  /** One channel's tune-in, throwing on failure. False when a newer tune owns the session. */
  private async startSession(channelId: number, seq: number): Promise<boolean> {
    // The next channel brings its own timeline; carrying the mapping over would
    // show the previous one's clock until the drift check caught up.
    this.playbackError.set(null);
    this.clockAnchor = null;
    this.baselineLatencyMs = Number.POSITIVE_INFINITY;
    // Read from a field, not `this.session()`: a concurrent call may already
    // have nulled the signal, which would hide the session this one must stop.
    const outgoingSessionId = this.currentSessionId;
    this.currentChannelId.set(channelId);
    void this.fetchPage(this.currentPage(), true);
    // Released before tuning, not after: a subscription capped at one connection
    // answers 409 to every zap while the outgoing channel still holds the slot.
    if (outgoingSessionId) {
      this.liveQoe.end();
      this.session.set(null);
      await this.api.stopSession(outgoingSessionId).catch(() => {});
      this.currentSessionId = null;
      if (seq !== this.tuneSeq) return false;
    }
    const session = await this.api.play(channelId, {
      directPlay: supportsLiveDirectPlay(this.engineKind),
      useTs: liveNeedsTs(this.engineKind),
    });
    if (seq !== this.tuneSeq) {
      // A later zap already won; don't leak this session or fight over the engine.
      void this.api.stopSession(session.sessionId).catch(() => {});
      return false;
    }
    this.currentSessionId = session.sessionId;
    this.session.set(session);
    this.liveQoe.begin(session.sessionId, () => this.engine);
    await this.loadIntoEngine(session);
    if (seq !== this.tuneSeq) return false;
    this.liveEdgeReached.set(true);
    this.recovery.resetStallWatchdog();
    return true;
  }

  private async tune(channelId: number): Promise<void> {
    // A zap fired while a previous one is still awaiting release/play must not
    // let a late resolution overwrite a more recent one's session or engine load.
    const seq = ++this.tuneSeq;
    this.zaps++;
    this.loading.set(true);
    this.recovery.clearEpisode();
    this.recovery.armClock();
    try {
      await this.startSession(channelId, seq);
    } catch (err) {
      if (seq === this.tuneSeq) this.handlePlayError(err);
    } finally {
      this.zaps--;
      if (seq === this.tuneSeq) this.loading.set(false);
    }
  }

  /** Recovery's re-tune of the playing channel: the playback position means nothing live. */
  private async retune(): Promise<'done' | 'superseded'> {
    const seq = ++this.tuneSeq;
    return (await this.startSession(this.currentChannelId(), seq)) ? 'done' : 'superseded';
  }

  private createRecovery(): RecoveryController {
    return new RecoveryController({
      playhead: () => this.engine,
      isDestroyed: () => this.destroyed,
      isOnline: () => this.network.isOnline(),
      hasMedia: () => !!this.currentSessionId || !!this.session(),
      isPaused: () => this.paused(),
      isLoading: () => this.loading(),
      reloadInFlight: () => this.zaps > 0,
      resumePosition: () => this.engine?.currentTime ?? 0,
      setRecovering: (on) => this.recovering.set(on),
      hasError: () => !!this.playbackError(),
      showFailure: (f) => this.showFailure(f),
      abandonReload: () => {
        this.tuneSeq++;
        this.loading.set(false);
      },
      reloadSession: () => this.retune(),
      reportRecovery: () => {},
    });
  }

  /** The error card for a failure the recovery gave up on; same taxonomy and panel as on-demand playback. */
  private showFailure(f: PlaybackFailure): void {
    this.loading.set(false);
    if ('thrown' in f && f.thrown !== undefined) {
      this.handlePlayError(f.thrown);
      return;
    }
    if ('engine' in f) {
      const e = f.engine;
      const source = e.source ?? 'engine';
      this.liveQoe.onError({ code: e.code, message: e.message, category: source });
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
      return;
    }
    const source = f.source ?? 'session';
    this.liveQoe.onError({ code: f.code, category: source });
    this.playbackError.set({ userMessage: this.translate.instant(userMessageKeyFor({ source, code: f.code })), source, code: f.code });
  }

  /** Only a gone or unreachable channel sends the viewer back; capacity, transient 5xx and timeouts surface on the retry overlay. */
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
        : err instanceof HttpErrorResponse && err.status === 409 && body?.code === 'livetv_user_at_capacity'
          ? this.translate.instant('liveTv.error_user_at_capacity', { limit: body.limit ?? 0 })
          : body?.code === 'livetv_account_expired'
            ? this.translate.instant('liveTv.error_account_expired', { sourceName: body.sourceName ?? '' })
            : this.translate.instant('liveTv.error_play_failed');
    const { source, code } = classifyPlaybackError(err);
    this.playbackError.set({ userMessage, source, code });
  }

  /** Two overlapping `tune()` calls must share one creation, not race two
   *  engines onto the same surface; the promise is cleared once it settles. */
  private ensureEngine(): Promise<PlaybackEngine> {
    if (this.engine) return Promise.resolve(this.engine);
    if (!this.engineCreation) {
      this.engineCreation = this.createEngine().finally(() => {
        this.engineCreation = null;
      });
    }
    return this.engineCreation;
  }

  private async createEngine(): Promise<PlaybackEngine> {
    const surface = await createEngineSurface({
      kind: this.surfaceKind,
      video: this.videoEl()!.nativeElement,
      container: this.containerEl()?.nativeElement,
    });
    const engine = surface.engine;
    if (this.destroyed) {
      // ngOnDestroy ran while the surface was still being created; nothing
      // will ever call destroy() on this one otherwise.
      void engine.destroy();
      throw new Error('live player destroyed during engine creation');
    }
    this.nativeSurfaceClaimed.set(surface.usesNativeSurface);
    this.bindEngine(engine);
    return engine;
  }

  private bindEngine(engine: PlaybackEngine): void {
    engine.volume = this.level();
    engine.on('error', (e) => this.recovery.onEngineError(e));
    engine.on('sessionExpired', () => void this.recovery.recoverFromLostSession('session_expired'));
    engine.on('stateChanged', ({ state }) => {
      this.paused.set(state === 'paused');
      this.liveQoe.onState(state);
    });
    engine.on('firstFrame', () => this.liveQoe.onFirstFrame());
    engine.on('volumechange', ({ volume, muted }) => {
      this.level.set(volume);
      this.muted.set(muted);
    });
    engine.on('timeUpdate', ({ position }) => {
      // Use the seekable range, not `buffered`: live buffer ends seconds ahead of the playhead, so seeking against it snaps back to the edge.
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
    // The spent controller keeps its attempt count: a fresh one gives the new tune its full retries.
    this.recovery.dispose();
    this.recovery = this.createRecovery();
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
    this.liveQoe.onSeek();
    void engine.seek(this.liveEdge() - this.behindLiveForBarPosition(seconds));
  }

  /** Bar position to seconds behind live, clamped to what the window retains (the bar may show a whole programme, only its tail is on disk). */
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
    this.liveQoe.onSeek();
    await engine.seek(this.liveEdge() - behind);
    this.liveEdgeReached.set(false);
  }

  async backToLive(): Promise<void> {
    if (!this.engine) return;
    this.liveQoe.onSeek();
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
    const list = this.channels();
    if (list.length === 0) return;
    const idx = list.findIndex((c) => c.id === this.currentChannelId());
    const nextIdx = (idx + direction + list.length) % list.length;
    void this.router.navigate(['/watch-live', list[nextIdx].id]);
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
    void this.loadChannels();
    if (this.miniGuideScrollTimer) clearTimeout(this.miniGuideScrollTimer);
    // A hundred channels in: open on the one being watched, not on the top. An off-window row has no DOM, so the window moves first.
    this.miniGuideScrollTimer = setTimeout(() => {
      this.miniGuideScrollTimer = null;
      const list = this.miniListEl()?.nativeElement;
      if (!list) return;
      const idx = this.channels().findIndex((c) => c.id === this.currentChannelId());
      if (idx >= 0) {
        list.scrollTop = Math.max(0, idx * this.rowPx() - (list.clientHeight - this.rowPx()) / 2);
        this.updateWindow(list);
      }
      afterNextRender(
        () => {
          const row = list.querySelector(`[data-channel-id="${this.currentChannelId()}"]`);
          row?.scrollIntoView({ block: 'center' });
          (row?.querySelector('button') as HTMLElement | null)?.focus();
        },
        { injector: this.injector },
      );
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

  selectFromMiniGuide(channel: LiveChannel): void {
    this.closeMiniGuide();
    if (channel.id !== this.currentChannelId()) void this.router.navigate(['/watch-live', channel.id]);
  }

  // ── Overlay + remote/keyboard ──


  private readonly onKeydownCapture = (event: KeyboardEvent): void => this.onKeydown(event);

  onKeydown(event: KeyboardEvent): void {
    const mapped = playerKeyAction(event);
    if (mapped?.kind === 'media') {
      this.onMediaKey(mapped.action, event);
      return;
    }
    // Space plays or pauses, never presses the focused button; in the guide it picks the channel.
    if (event.key === ' ' && !this.miniGuideOpen()) {
      event.preventDefault();
      event.stopPropagation();
      this.togglePlay();
      this.chrome.show();
      return;
    }
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
        event.stopPropagation();
        this.chrome.show();
        // The next arrows scrub on the armed seekbar, one deferred seek for the lot.
        this.controlsCmp()?.seekbar()?.focus();
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

  private onMediaKey(action: MediaKeyAction, event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (action === 'stop') {
      this.goBack();
      return;
    }
    const engine = this.engine;
    if (!engine) return;
    if (action === 'toggle' || (action === 'play' && engine.paused) || (action === 'pause' && !engine.paused)) {
      this.togglePlay();
    } else if (action === 'forward') this.onSeek(this.dvrPosition() + 10);
    else if (action === 'rewind') this.onSeek(this.dvrPosition() - 10);
    this.chrome.show();
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
      return formatBitrate(bps);
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

  /** Keeps the playhead wall clock; a seek keeps the mapping valid, only a rebased timeline (respawn, discontinuity) needs re-anchoring. */
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
    const target = this.channels().find((c) => c.number === Number(buffer));
    if (target) void this.router.navigate(['/watch-live', target.id]);
  }

  private async teardownSession(): Promise<void> {
    const id = this.currentSessionId ?? this.session()?.sessionId;
    this.liveQoe.end();
    if (id) await this.api.stopSession(id).catch(() => {});
  }

  readonly progressPercent = programmeProgressPercent;
}
