import { Component, ChangeDetectionStrategy, inject, signal, OnInit, OnDestroy, Injector } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media, CalendarEntry } from '../../core/services/api/media.service';
import { StreamingApiService, ContinueWatchingItem, RecommendationItem } from '../../core/services/api/streaming-api.service';
import { LibrariesApiService, LibrarySummary } from '../../core/services/api/libraries-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { CastService } from '../../core/services/cast.service';
import { CastPlayerService } from '../../core/services/cast-player.service';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { LucideIconComponent } from '../../shared/components/lucide-icon';

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
 * excluding already-watched and missing-file entries.
 * Data: `GET /api/media?sortBy=createdAt&sortOrder=DESC&limit=20&excludeWatched=true&missing=false`.
 *
 * ## Recommandations
 * Genre-based suggestions derived from the user's watch history.
 * See `RecommendationService` for the algorithm.
 * Data: `GET /api/playback/recommendations`.
 */
@Component({
  selector: 'app-home',
  imports: [
    RouterLink, TranslateModule, FormsModule,
    MediaCardComponent,
    HorizontalScrollerComponent,
    LucideIconComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
})
export class HomeComponent implements OnInit, OnDestroy {
  private readonly mediaService = inject(MediaService);
  private readonly streamingApi = inject(StreamingApiService);
  private readonly confirmation = inject(ConfirmationService);
  private readonly router = inject(Router);
  private readonly castService = inject(CastService);
  private readonly castPlayer = inject(CastPlayerService);
  private readonly librariesApi = inject(LibrariesApiService);
  private readonly scrollMemory = inject(ScrollMemoryService);
  private readonly injector = inject(Injector);

  private static readonly SCROLL_KEY = 'home';

  readonly loading = signal(true);
  readonly libraries = signal<LibrarySummary[]>([]);
  readonly continueWatching = signal<ContinueWatchingItem[]>([]);
  readonly recentMedia = signal<Media[]>([]);
  readonly comingSoon = signal<CalendarEntry[]>([]);
  readonly recommendations = signal<RecommendationItem[]>([]);
  readonly onlyMyRequests = signal(
    localStorage.getItem('fliks.home.onlyMyRequests') === 'true',
  );

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
    // Track scroll for back-navigation restore. Same pattern as /libraries.
    this.scrollMemory.activate(HomeComponent.SCROLL_KEY);
    // Load non-filterable sections once
    try {
      const [libs, cw, recs] = await Promise.all([
        this.librariesApi.listMine().catch(() => []),
        this.streamingApi.getContinueWatching().catch(() => []),
        this.streamingApi.getRecommendations().catch(() => []),
      ]);
      this.libraries.set(libs);
      this.continueWatching.set(cw);
      this.recommendations.set(recs);
    } catch { /* ignore */ }
    // Load filterable sections (recent + coming soon)
    await this.loadFilteredSections();
    this.loading.set(false);
    // Restore scroll once everything is in the DOM.
    this.scrollMemory.restore(HomeComponent.SCROLL_KEY, this.injector);
  }

  ngOnDestroy() {
    this.scrollMemory.deactivate();
  }

  async toggleOnlyMyRequests() {
    this.onlyMyRequests.update((v) => !v);
    localStorage.setItem('fliks.home.onlyMyRequests', String(this.onlyMyRequests()));
    await this.loadFilteredSections();
  }

  private async loadFilteredSections() {
    const mine = this.onlyMyRequests();
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
          missing: false,
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

  async playContinueWatching(item: ContinueWatchingItem) {
    if (this.castService.isConnected()) {
      await this.castPlayer.quickStart({
        mediaFileId: item.mediaFileId,
        mediaId: item.mediaId,
        episodeId: item.episodeId ?? undefined,
        title: item.mediaTitle,
        episodeTitle: item.episodeLabel ?? undefined,
        fanartUrl: item.fanartUrl ?? item.posterUrl,
      });
      this.castPlayer.expanded.set(true);
    } else {
      const qp: Record<string, number> = { mediaId: item.mediaId };
      if (item.episodeId) qp['episodeId'] = item.episodeId;
      this.router.navigate(['/watch', item.mediaFileId], { queryParams: qp });
    }
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
