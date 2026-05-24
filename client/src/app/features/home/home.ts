import { Component, ChangeDetectionStrategy, inject, signal, effect, OnInit, OnDestroy, Injector, afterNextRender } from '@angular/core';
import { ActivatedRoute, NavigationStart, Router, RouterLink } from '@angular/router';
import { Subscription, filter } from 'rxjs';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media, CalendarEntry } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem, RecommendationItem } from '../../core/services/api/streaming-api.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { PlayableMediaService } from '../../core/services/playable-media.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { FocusMemoryService } from '../../core/services/focus-memory.service';
import { NavbarService } from '../../core/services/navbar.service';
import { BackgroundService } from '../../core/services/background.service';
import { DisplaySettingsService } from '../../core/services/display-settings.service';
import { TvService } from '../../core/services/tv.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { LucideIconComponent } from '../../shared/components/lucide-icon';
import { SetupChecklistComponent } from '../../shared/components/setup-checklist/setup-checklist';
import { TvSectionDirective } from '../../shared/directives/tv-section.directive';
import { AuthService } from '../../core/services/auth.service';

/**
 * # Home page
 *
 * Displays several horizontal scroller sections:
 *
 * ## Libraries
 * One card per accessible library with custom icon + color gradient.
 * Data: `GET /api/libraries/mine`.
 *
 * ## Continuer à regarder
 * Media the user started but didn't finish (< 90% or < dur-30s).
 * Data: `GET /api/playback/continue-watching`.
 *
 * ## Bientôt disponible
 * Movies (digitalRelease) and episodes (airDate) releasing within
 * -3 days to +30 days that are monitored and don't have a file yet.
 * Keeps entries visible up to 3 days after release date so newly
 * released content stays until actually downloaded.
 * Data: `GET /api/media/calendar?start=<J-3>&end=<J+30>&monitoredOnly=true`.
 * Client-side filter: `!hasFile && (event === 'digital' || 'airing' || 'release')`.
 * Deduplicated by mediaId (earliest date kept).
 *
 * ## Récemment ajoutés
 * Last 20 media added to the library (movies + series mixed),
 * excluding already-watched entries. Includes items still awaiting download.
 * Data: `GET /api/media?sortBy=createdAt&sortOrder=DESC&limit=20&excludeWatched=true`.
 *
 * ## Recommandations
 * Genre-based suggestions derived from the user's watch history.
 * See `RecommendationService` for the algorithm.
 * Data: `GET /api/playback/recommendations`.
 */
@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule,
    MediaCardComponent,
    HorizontalScrollerComponent,
    LucideIconComponent,
    SetupChecklistComponent,
    TvSectionDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly focusMemory = inject(FocusMemoryService);
  private readonly navbar = inject(NavbarService);
  private readonly backgroundService = inject(BackgroundService);
  private readonly displaySettings = inject(DisplaySettingsService);
  readonly auth = inject(AuthService);
  private readonly tv = inject(TvService);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  private readonly reuseStrategy = inject(CachingReuseStrategy);

  private static readonly SCROLL_KEY = 'home';
  private static readonly FOCUS_KEY = 'home';
  /** Captured at ngOnInit before NavbarService.lastWasBack auto-resets. */
  private arrivedViaBack = false;
  private navStartSub?: Subscription;
  private attachedSub?: Subscription;
  private detachedSub?: Subscription;

  readonly libraries = signal<LibrarySummary[]>([]);
  readonly continueWatching = signal<ContinueWatchingItem[]>([]);
  readonly recentMedia = signal<Media[]>([]);
  readonly comingSoon = signal<CalendarEntry[]>([]);
  readonly recommendations = signal<RecommendationItem[]>([]);

  /** Once the recommendations land, randomise the page background
   *  using their fanarts (primary + extras). One pick per visit;
   *  the BackgroundService keeps it stable while the user stays on
   *  the home — same contract as media-detail. */
  private readonly recommendationsBackgroundEffect = effect(() => {
    const recs = this.recommendations();
    if (recs.length === 0) return;
    if (!this.displaySettings.settings().homeBackground) {
      this.backgroundService.clear();
      return;
    }
    const pool: string[] = [];
    for (const r of recs) {
      if (r.media.fanartUrl) pool.push(r.media.fanartUrl);
      pool.push(...(r.media.additionalFanartUrls ?? []));
    }
    if (pool.length) this.backgroundService.setBackgrounds(pool);
  });
  /** Reactively re-filter the home rows whenever the user flips the
   *  "only my requests" toggle in display settings. Skips the very first
   *  invocation so we don't double-fetch on initial page load — ngOnInit
   *  already calls loadAllSections(). */
  private firstOnlyMyRequestsRun = true;
  private readonly onlyMyRequestsEffect = effect(() => {
    void this.displaySettings.settings().onlyMyRequests;
    if (this.firstOnlyMyRequestsRun) {
      this.firstOnlyMyRequestsRun = false;
      return;
    }
    void this.loadFilteredSections();
  });

  libraryUrl(lib: LibrarySummary): string {
    return `/libraries/${encodeURIComponent(lib.name)}`;
  }

  /** CSS color for library card. DaisyUI 5 names → var(--color-<name>). */
  libraryColor(lib: LibrarySummary): string {
    const c = lib.color || 'primary';
    const daisyColors = ['primary', 'secondary', 'accent', 'info', 'success', 'warning', 'error'];
    if (daisyColors.includes(c)) return `var(--color-${c})`;
    return c;
  }

  async ngOnInit() {
    this.arrivedViaBack = this.navbar.lastWasBack();
    this.scrollMemory.activate(HomeComponent.SCROLL_KEY);
    // Each section guards itself with `@if (().length)` so sections paint
    // independently as their data arrives. No global loading gate.
    await this.loadAllSections();
    // App-open SWR: the cache served Pass 1 above (instant render even on
    // a cold network). Now force a network round-trip so the user sees
    // the freshest data — additions, watched-status flips made on
    // another device, new recommendations, etc. — without waiting on it.
    // Signals already populated, so a slower fresh response just
    // overwrites in place; no spinner, no flash.
    queueMicrotask(() => void this.loadAllSections({ force: true }));
    this.scrollMemory.restore(HomeComponent.SCROLL_KEY, this.injector);
    if (this.tv.isTv()) {
      afterNextRender(() => this.applyDefaultFocus(), { injector: this.injector });
      // NavigationStart fires the moment a click triggers a route change,
      // before Angular tears down this component — activeElement is still
      // the focused card so we can capture its data-home-focus once.
      this.navStartSub = this.router.events
        .pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
        .subscribe(() => {
          const active = document.activeElement as HTMLElement | null;
          const container = active?.closest<HTMLElement>('[data-home-focus]');
          const sel = container?.dataset['homeFocus'];
          if (sel) this.focusMemory.save(HomeComponent.FOCUS_KEY, sel);
        });
    }
    // The route is detached/cached on navigate-away (see CachingReuseStrategy
    // + `data: { reuse: true }` on the home route). On return, ngOnInit does
    // NOT fire again — refresh data + scroll + focus through this hook
    // instead. Stale signals stay visible during the background refetch (HTTP
    // cache makes that near-instant when warm), so the user never sees a
    // spinner on a back navigation.
    const ownKey = this.reuseStrategy.keyFor(this.route.snapshot);
    this.attachedSub = this.reuseStrategy.attached$.subscribe((key) => {
      if (key !== ownKey) return;
      this.scrollMemory.activate(HomeComponent.SCROLL_KEY);
      void this.loadAllSections();
      this.scrollMemory.restoreSticky(HomeComponent.SCROLL_KEY);
      if (this.tv.isTv()) {
        this.arrivedViaBack = true;
        afterNextRender(() => this.applyDefaultFocus(), { injector: this.injector });
      }
    });
    // ngOnDestroy doesn't fire when detaching, so the active scroll key would
    // stay pointing at us — and a NavigationStart on the next page would then
    // overwrite our saved scroll position. Deactivate iff still ours: if the
    // next route already claimed scrollMemory in its own ngOnInit, we leave
    // its key alone.
    this.detachedSub = this.reuseStrategy.detached$.subscribe((key) => {
      if (key === ownKey) this.scrollMemory.deactivateIf(HomeComponent.SCROLL_KEY);
    });
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
    this.navStartSub?.unsubscribe();
    this.attachedSub?.unsubscribe();
    this.detachedSub?.unsubscribe();
    this.backgroundService.clear();
  }

  /**
   * Fetch every section in parallel. Signals are updated as responses land —
   * existing values stay visible until each new response arrives, so a
   * background revalidation never blanks the UI.
   *
   * The pattern is two-pass SWR-on-demand:
   *   • Pass 1 (default): cache-first. The interceptor serves IndexedDB
   *     if fresh, network otherwise. Renders the home in ≤1 frame on a
   *     warm cache.
   *   • Pass 2 (`{ force: true }`): always go to network. Fired right
   *     after Pass 1 from `ngOnInit` to refresh the home's data even
   *     when the cache was fresh — the user expects the page to reflect
   *     current backend state every time they open the app, but doesn't
   *     want to wait for the network for the first paint.
   */
  private async loadAllSections(opts: { force?: boolean } = {}): Promise<void> {
    const force = !!opts.force;
    try {
      const [libs, cw, recs] = await Promise.all([
        this.librariesApi.listMine({ force }).catch(() => null),
        this.streamingApi.getContinueWatching(undefined, { force }).catch(() => null),
        this.streamingApi.getRecommendations({ force }).catch(() => null),
      ]);
      if (libs) this.libraries.set(libs);
      if (cw) this.continueWatching.set(cw);
      if (recs) this.recommendations.set(recs);
    } catch { /* ignore */ }
    await this.loadFilteredSections();
  }

  private applyDefaultFocus() {
    const root = document.querySelector<HTMLElement>('app-home') ?? document.body;
    const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex="0"]';
    if (this.arrivedViaBack) {
      const saved = this.focusMemory.retrieve(HomeComponent.FOCUS_KEY);
      const container = saved
        ? root.querySelector<HTMLElement>(`[data-home-focus="${CSS.escape(saved)}"]`)
        : null;
      const target =
        container?.matches(FOCUSABLE)
          ? container
          : container?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
      if (target) {
        target.focus({ preventScroll: false });
        return;
      }
    }
    // Default: first focusable in DOM order = first library card.
    root.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: false });
  }

  private async loadFilteredSections() {
    const mine = this.displaySettings.settings().onlyMyRequests;
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const in30d = new Date(today);
    in30d.setDate(in30d.getDate() + 30);
    const startStr = threeDaysAgo.toISOString().slice(0, 10);
    const in30dStr = in30d.toISOString().slice(0, 10);

    try {
      const [recent, calendar] = await Promise.all([
        this.mediaService.getAll({
          sortBy: 'createdAt',
          sortOrder: 'DESC',
          limit: 20,
          excludeWatched: true,
          requestedByMe: mine || undefined,
        }),
        this.mediaService.getCalendar(startStr, in30dStr, true, mine).catch(() => []),
      ]);
      this.recentMedia.set(recent.data);
      const upcoming = calendar
        .filter((e) => !e.hasFile && (e.event === 'digital' || e.event === 'airing' || e.event === 'release'))
        .sort((a, b) => a.date.localeCompare(b.date));
      const seen = new Set<number>();
      this.comingSoon.set(
        upcoming.filter((e) => {
          if (seen.has(e.mediaId)) return false;
          seen.add(e.mediaId);
          return true;
        }),
      );
    } catch { /* ignore */ }
  }

  /**
   * Persist a "remove from recommendations" gesture. The local list is
   * updated optimistically so the card disappears immediately; a failed
   * request restores it via a fresh fetch.
   */
  async dismissRecommendation(rec: RecommendationItem) {
    const id = rec.media.id;
    this.recommendations.update((list) => list.filter((r) => r.media.id !== id));
    try {
      await this.streamingApi.dismissRecommendation(id);
    } catch {
      // Restore the row by refetching — the global error toast already fired.
      this.streamingApi
        .getRecommendations()
        .then((list) => this.recommendations.set(list))
        .catch(() => {});
    }
  }

  /**
   * Recommendation cards expose a Lire action even though the lean DTO
   * doesn't carry file ids — we fetch the full media on demand and route
   * to the first playable file. If nothing is playable (e.g. a "to add"
   * suggestion not yet downloaded) we fall back to the detail page.
   */
  async playRecommendation(rec: RecommendationItem) {
    try {
      const media = await this.mediaService.getOne(rec.media.id);
      const file = media.files?.[0];
      if (!file) {
        const segment = media.type === 'series' ? 'series' : 'movies';
        void this.router.navigate(['/' + segment, media.id]);
        return;
      }
      await this.playableMedia.play({
        fileId: file.id,
        mediaId: media.id,
        episodeId: file.episodeId ?? undefined,
        title: media.title,
        fanartUrl: media.fanartUrl ?? media.posterUrl ?? null,
        streamInfo: (file as any).streamInfo,
      }, false);
    } catch {
      /* error handled by global interceptor */
    }
  }

  async playContinueWatching(item: ContinueWatchingItem) {
    await this.playableMedia.play({
      fileId: item.mediaFileId,
      mediaId: item.mediaId,
      episodeId: item.episodeId ?? undefined,
      title: item.mediaTitle,
      episodeTitle: item.episodeLabel ?? undefined,
      fanartUrl: item.fanartUrl ?? item.posterUrl ?? null,
      stillUrl: item.stillUrl ?? null,
    }, false);
  }

  /** "Mark as watched" can only fire on a movie with at least one file
   *  or a series (bulk-toggle endpoint). For lean rows that don't expose
   *  a file (e.g. recommendations without a local copy) the action stays
   *  hidden from the context menu. */
  canMarkMediaWatched(m: Media): boolean {
    return m.type === 'series' || !!m.files?.length;
  }

  async toggleContinueWatchingWatched(item: ContinueWatchingItem, watched: boolean) {
    try {
      await this.streamingApi.toggleWatched(item.mediaId, item.mediaFileId, item.episodeId ?? undefined);
      // Mark-watched drops the current episode but may surface the next
      // one in the series (the backend auto-advances continue-watching).
      // Refetch the row instead of filtering locally so the user sees the
      // next episode appear in place rather than the card vanishing.
      if (watched) {
        const list = await this.streamingApi.getContinueWatching(undefined, { force: true }).catch(() => null);
        if (list) this.continueWatching.set(list);
      }
    } catch { /* global error toast */ }
  }

  async toggleRecentMediaWatched(m: Media, watched: boolean) {
    try {
      if (m.type === 'series') {
        await this.streamingApi.toggleSeriesWatched(m.id, watched);
      } else {
        const fileId = m.files?.[0]?.id;
        if (!fileId) return;
        await this.streamingApi.toggleWatched(m.id, fileId);
      }
      if (watched) {
        // Recently-added is loaded with excludeWatched=true, so a watched
        // row would vanish on the next refresh anyway — remove it now to
        // match the visible expectation.
        this.recentMedia.update(list => list.filter(x => x.id !== m.id));
      }
    } catch { /* global error toast */ }
  }

  async removeContinueWatching(item: ContinueWatchingItem) {
    const confirmed = await this.confirmation.confirm({
      title: 'Retirer',
      message: `Retirer "${item.mediaTitle}" de la liste ?`,
    });
    if (!confirmed) return;
    try {
      await this.streamingApi.hideFromContinueWatching(item.mediaId);
      this.continueWatching.update(list => list.filter(i => i.mediaId !== item.mediaId));
    } catch { /* ignore */ }
  }
}
