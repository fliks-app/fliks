import { computed, signal, type WritableSignal } from '@angular/core';
import type { TranslateService } from '@ngx-translate/core';
import type { Episode, Media, Season } from '../../core/services/api/media.service';
import type { DownloadProgressService } from '../../core/services/download-progress.service';
import { serverMessage } from '../../core/utils/server-message';
import type { ReleasesModalComponent } from './components/releases-modal/releases-modal.component';
import type { MediaDetailReleasePickerService, MovieRelease } from './media-detail-release-picker.service';
import { isUnprofiledReleaseError, releaseGrabBody } from './media-detail-release.utils';
import type { IndexerRosterEntry, ReleaseSearchStreamService } from './release-search-stream.service';
import { KIND_REGISTRY } from '../../core/media-kinds';

export interface ReleaseGrabHost {
  media(): Media | null;
  focusedSeason(): Season | null;
  focusedEpisode(): Episode | null;
  movieModal(): ReleasesModalComponent | undefined;
  episodeModal(): ReleasesModalComponent | undefined;
  seasonModal(): ReleasesModalComponent | undefined;
}

export interface ReleaseGrabDeps {
  stream: ReleaseSearchStreamService;
  api: MediaDetailReleasePickerService;
  progress: DownloadProgressService;
  translate: TranslateService;
}

/** Season / episode a grab targets, matching the leaf its download lands under.
 *  Empty for a movie, or a whole-series grab with no season scope. */
type GrabScope = { seasonNumber?: number; episodeNumber?: number };

/** How long a successful grab keeps the search phase while the download
 *  client's first tick makes its way over SSE. */
const GRAB_HANDOFF_MS = 8000;

const RELEASES_EMPTY = 'media_detail.releases_empty';

/** Release search and grab for the movie, the focused episode and a season: the lists the
 *  modals show, the busy flags, and the per-release result marks. */
export class ReleaseGrabController {
  readonly releases = signal<MovieRelease[]>([]);
  /** Indexers this search queries and where each one is, pushed while it runs. */
  readonly releasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly releasesLoading = signal(false);
  readonly releasesSearched = signal(false);
  readonly releasesError = signal('');
  readonly releasesEmptyMessage = signal(RELEASES_EMPTY);
  readonly grabBusy = signal<string | null>(null);
  readonly grabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Movie ids with a grab-best in flight. A set, not a flag: the component
   *  outlives navigation, so a flag would follow the user to the next title. */
  readonly movieGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  /** Only this movie's own grab-best spins; a modal release grab still locks it. */
  readonly movieHeaderGrabBusy = computed(() =>
    this.movieGrabBestBusy().has(this.host.media()?.id ?? 0) ? 'best' : this.grabBusy(),
  );

  readonly selectedEpisodeId = signal<number | null>(null);
  readonly epReleases = signal<MovieRelease[]>([]);
  readonly epReleasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly epReleasesLoading = signal(false);
  readonly epReleasesSearched = signal(false);
  readonly epReleasesError = signal('');
  readonly epReleasesEmptyMessage = signal(RELEASES_EMPTY);
  readonly epGrabBusy = signal<string | null>(null);
  readonly epGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Episode ids with a grab-best in flight — several may run at once. */
  readonly epGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  /** Only the focused episode's own grab-best spins here. */
  readonly epHeaderGrabBusy = computed(() =>
    this.epGrabBestBusy().has(this.host.focusedEpisode()?.id ?? 0) ? 'best' : this.epGrabBusy(),
  );

  readonly seasonGrabBusy = signal<string | null>(null);
  readonly seasonReleaseGrabState = signal<Map<string, 'ok' | 'error'>>(new Map());
  /** Season ids with a grab-best in flight — several may run at once. */
  readonly seasonGrabBestBusy = signal<ReadonlySet<number>>(new Set());
  readonly seasonReleasesOpen = signal<number | null>(null);
  readonly seasonForReleases = signal<Season | null>(null);
  readonly seasonReleases = signal<MovieRelease[]>([]);
  readonly seasonReleasesIndexers = signal<IndexerRosterEntry[]>([]);
  readonly seasonReleasesLoading = signal(false);
  readonly seasonReleasesError = signal('');
  readonly seasonReleasesEmptyMessage = signal(RELEASES_EMPTY);

  constructor(
    private readonly host: ReleaseGrabHost,
    private readonly deps: ReleaseGrabDeps,
  ) {}

  async loadReleases() {
    const m = this.host.media();
    if (!m || KIND_REGISTRY[m.type].hasSeasons) return;
    this.releasesLoading.set(true);
    this.releasesError.set('');
    this.releasesEmptyMessage.set(RELEASES_EMPTY);
    this.releases.set([]);
    this.releasesIndexers.set([]);
    this.releasesSearched.set(false);
    this.host.movieModal()?.showModal();
    try {
      const rows = await this.deps.stream.run(
        (searchId) => this.deps.api.getMovieReleases(m.id, undefined, searchId),
        { releases: this.releases, indexers: this.releasesIndexers },
      );
      this.releases.set(rows);
      this.releasesSearched.set(true);
    } catch (err: unknown) {
      this.releases.set([]);
      this.releasesSearched.set(true);
      if (isUnprofiledReleaseError(err)) {
        this.releasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.releasesError.set(serverMessage(err, this.deps.translate, 'media_detail.releases_error'));
      }
    } finally {
      this.releasesLoading.set(false);
    }
  }

  /** Run a grab with the header badge showing its search phase from the click.
   *  The first progress event hands the badge to the real download; failure clears the phase. */
  private async withGrabPhase<T>(scope: GrabScope, run: () => Promise<T>): Promise<T> {
    const m = this.host.media();
    const release = m
      ? this.deps.progress.markGrabbing({ mediaId: m.id, mediaType: m.type, ...scope })
      : () => undefined;
    try {
      const out = await run();
      // Keep the phase up until the download client's first SSE tick; only clears a leaf still `searching`.
      setTimeout(release, GRAB_HANDOFF_MS);
      return out;
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Grab scope for an episode id — the leaf key its download will land under. */
  private episodeScope(episodeId: number): GrabScope {
    for (const s of this.host.media()?.seasons ?? []) {
      const ep = s.episodes?.find((e) => e.id === episodeId);
      if (ep) return { seasonNumber: s.seasonNumber, episodeNumber: ep.episodeNumber };
    }
    return {};
  }

  /** Runs one grab-best tracked by target id, so grabs on other targets don't spin or disable this one.
   *  Re-entry on the same id is dropped (double-click guard). */
  private async runGrabBest(
    busy: WritableSignal<ReadonlySet<number>>,
    id: number,
    scope: GrabScope,
    grab: () => Promise<void>,
  ): Promise<void> {
    if (busy().has(id)) return;
    busy.update((s) => new Set(s).add(id));
    try {
      await this.withGrabPhase(scope, grab);
    } catch {
      /* error toast surfaced by the global interceptor */
    } finally {
      busy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async grabBest() {
    const m = this.host.media();
    if (!m || KIND_REGISTRY[m.type].hasSeasons) return;
    await this.runGrabBest(this.movieGrabBestBusy, m.id, {}, () => this.deps.api.grabMovie(m.id, {}));
  }

  async grabRelease(r: MovieRelease, key: string) {
    const m = this.host.media();
    if (!m || KIND_REGISTRY[m.type].hasSeasons) return;
    this.grabBusy.set(key);
    try {
      await this.withGrabPhase({}, () => this.deps.api.grabMovie(m.id, releaseGrabBody(r)));
      this.grabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.grabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.grabBusy.set(null);
    }
  }

  /** Header releases button: reads the focus signals so the template needs no
   *  season in scope, which it doesn't have until the media lands. */
  loadFocusedEpisodeReleases(): void {
    const m = this.host.media();
    const s = this.host.focusedSeason();
    const ep = this.host.focusedEpisode();
    if (!m || !s || !ep) return;
    void this.loadEpisodeReleases(m.id, ep.id);
  }

  async loadEpisodeReleases(mediaId: number, episodeId: number) {
    this.selectedEpisodeId.set(episodeId);
    this.epReleases.set([]);
    this.epReleasesIndexers.set([]);
    this.epReleasesSearched.set(false);
    this.epReleasesError.set('');
    this.epReleasesEmptyMessage.set(RELEASES_EMPTY);
    this.epReleasesLoading.set(true);
    this.host.episodeModal()?.showModal();
    try {
      const rows = await this.deps.stream.run(
        (searchId) => this.deps.api.getEpisodeReleases(mediaId, episodeId, undefined, searchId),
        { releases: this.epReleases, indexers: this.epReleasesIndexers },
      );
      this.epReleases.set(rows);
      this.epReleasesSearched.set(true);
    } catch (err: unknown) {
      this.epReleasesSearched.set(true);
      if (isUnprofiledReleaseError(err)) {
        this.epReleasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.epReleasesError.set(serverMessage(err, this.deps.translate, 'media_detail.releases_error'));
      }
    } finally {
      this.epReleasesLoading.set(false);
    }
  }

  async grabEpisodeBest(mediaId: number, episodeId: number) {
    await this.runGrabBest(this.epGrabBestBusy, episodeId, this.episodeScope(episodeId), () =>
      this.deps.api.grabEpisode(mediaId, episodeId, {}),
    );
  }

  async grabEpisodeRelease(mediaId: number, episodeId: number, r: MovieRelease, key: string) {
    this.epGrabBusy.set(key);
    try {
      await this.withGrabPhase(this.episodeScope(episodeId), () =>
        this.deps.api.grabEpisode(mediaId, episodeId, releaseGrabBody(r)),
      );
      this.epGrabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.epGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.epGrabBusy.set(null);
    }
  }

  async loadSeasonReleases(mediaId: number, season: Season) {
    this.seasonReleasesOpen.set(season.id);
    this.seasonForReleases.set(season);
    this.seasonReleases.set([]);
    this.seasonReleasesIndexers.set([]);
    this.seasonReleasesError.set('');
    this.seasonReleasesEmptyMessage.set(RELEASES_EMPTY);
    this.seasonReleasesLoading.set(true);
    this.host.seasonModal()?.showModal();
    try {
      const rows = await this.deps.stream.run(
        (searchId) => this.deps.api.getSeasonReleases(mediaId, season.id, undefined, searchId),
        { releases: this.seasonReleases, indexers: this.seasonReleasesIndexers },
      );
      this.seasonReleases.set(rows);
    } catch (err: unknown) {
      if (isUnprofiledReleaseError(err)) {
        this.seasonReleasesEmptyMessage.set('media_detail.no_quality_profile');
      } else {
        this.seasonReleasesError.set(
          serverMessage(err, this.deps.translate, 'media_detail.releases_error'),
        );
      }
    } finally {
      this.seasonReleasesLoading.set(false);
    }
  }

  async grabSeasonAuto(mediaId: number, season: Season) {
    await this.runGrabBest(this.seasonGrabBestBusy, season.id, { seasonNumber: season.seasonNumber }, () =>
      this.deps.api.grabSeason(mediaId, season.id, {}),
    );
  }

  onGrabSeasonReleaseFromModal(mediaId: number, r: MovieRelease, key: string) {
    const season = this.seasonForReleases();
    if (!season) return;
    void this.grabSeasonRelease(mediaId, season, r, key);
  }

  async grabSeasonRelease(mediaId: number, season: Season, r: MovieRelease, key: string) {
    this.seasonGrabBusy.set(key);
    try {
      await this.withGrabPhase({ seasonNumber: season.seasonNumber }, () =>
        this.deps.api.grabSeason(mediaId, season.id, releaseGrabBody(r)),
      );
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'ok'));
    } catch {
      this.seasonReleaseGrabState.update((s) => new Map(s).set(key, 'error'));
    } finally {
      this.seasonGrabBusy.set(null);
    }
  }
}
