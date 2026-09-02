import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet, UpperCasePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideCheck,
  LucideClipboardList,
  LucideDownload,
  LucideEllipsisVertical,
  LucideEye,
  LucideEyeOff,
  LucideHeart,
  LucideLayoutGrid,
  LucideList,
  LucideListChecks,
  LucideListPlus,
  LucidePackage,
  LucideUserPlus,
  LucideX,
} from '@lucide/angular';
import { HorizontalScrollerComponent } from '../../../../shared/components/horizontal-scroller';
import { centerRailOnCard } from '../../../../shared/utils/center-rail';
import { MediaCardComponent } from '../../../../shared/components/media-card/media-card';
import { DropdownMenuComponent } from '../../../../shared/components/dropdown-menu';
import { DropdownOptionComponent } from '../../../../shared/components/dropdown-option/dropdown-option';
import { TvRowDirective } from '../../../../shared/directives/tv-row.directive';
import { SynopsisComponent } from '../../../../shared/components/synopsis/synopsis';
import { CollapsibleSectionComponent } from '../../../../shared/components/collapsible-section/collapsible-section';
import {
  Episode,
  Media,
  Season,
} from '../../../../core/services/api/media.service';
import {
  displayMediaFilePath,
  episodeBadgeLabel,
  episodeUnreleased,
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  onDiskEpisodeNumbers,
  seasonsVisibleWithDiskFilter,
} from '../../media-detail.utils';
import { PlayableMediaService } from '../../../../core/services/playable-media.service';
import { AddToPlaylistService } from '../../../../core/services/add-to-playlist.service';
import { TvService } from '../../../../core/services/tv.service';
import { AuthService } from '../../../../core/services/auth.service';
import { SpoilerService } from '../../../../core/services/spoiler.service';
import { DeviceService } from '../../../../core/services/device.service';
import { DisplaySettingsService } from '../../../../core/services/display-settings.service';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';
import { SeasonLabelPipe } from '../../../../core/pipes/season-label.pipe';
import { PluginUiRegistryService } from '../../../../core/plugin-ui/plugin-ui-registry.service';
import { evaluateWhen, type WhenContext } from '../../../../core/plugin-ui/when-evaluator';
import { resolveSeasonAction, type CoreSeasonActionId, type SeasonActionHandlers } from '../../../../core/plugin-ui/season-action-registry';

const LS_EPISODE_VIEW = 'fliks.mediaDetail.episodeView';

type EpisodeView = 'grid' | 'list';

function readEpisodeViewFromStorage(): EpisodeView {
  if (typeof localStorage === 'undefined') return 'grid';
  try {
    return localStorage.getItem(LS_EPISODE_VIEW) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}


@Component({
  selector: 'app-media-detail-seasons',
  imports: [TranslateModule, UpperCasePipe, SeasonLabelPipe, NgTemplateOutlet, RouterLink, LocaleDatePipe, HorizontalScrollerComponent, CollapsibleSectionComponent, MediaCardComponent, DropdownMenuComponent, DropdownOptionComponent, TvRowDirective, SynopsisComponent, LucideCheck, LucideClipboardList, LucideDownload, LucideEllipsisVertical, LucideEye, LucideEyeOff, LucideHeart, LucideLayoutGrid, LucideList, LucideListChecks, LucideListPlus, LucidePackage, LucideUserPlus, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-seasons.component.html',
})
export class MediaDetailSeasonsComponent {
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly addToPlaylist = inject(AddToPlaylistService);
  private readonly translate = inject(TranslateService);
  readonly tv = inject(TvService);
  readonly auth = inject(AuthService);
  private readonly spoilers = inject(SpoilerService);
  private readonly device = inject(DeviceService);
  private readonly pluginUi = inject(PluginUiRegistryService);
  private readonly displaySettings = inject(DisplaySettingsService);
  readonly media = input.required<Media>();
  readonly selectedSeason = input<Season | null>(null);
  readonly activeSeasonId = input.required<number | null>();
  readonly episodesHasFileOnly = input(false);

  /** Onglets saisons : masque les saisons vides quand « épisodes sur disque uniquement ». */
  readonly displaySeasons = computed(() =>
    seasonsVisibleWithDiskFilter(this.media(), this.episodesHasFileOnly()),
  );
  readonly filteredEpisodes = input.required<Episode[]>();
  readonly seasonReleasesLoading = input(false);
  readonly seasonReleasesOpenId = input<number | null>(null);
  readonly seasonGrabBusy = input<string | null>(null);
  /** Season ids with a grab-best in flight, so one running season never locks the others. */
  readonly seasonGrabBestBusyIds = input<ReadonlySet<number>>(new Set());
  readonly seasonBusyId = input<number | null>(null);
  readonly watchedEpisodeIds = input<Set<number>>(new Set());
  readonly episodeProgress = input<Record<number, number>>({});
  readonly isAdmin = input(false);
  /** Viewer can submit a request (regular requester). Surfaces the
   *  Demander entry for any season that still has missing episodes. */
  readonly canRequest = input(false);
  /** Season numbers already covered by an active request from the
   *  viewer — those rows skip the Demander entry. */
  readonly userRequestedSeasonNumbers = input<number[]>([]);
  /** Hide the action bar (season select, bulk actions). Used by the
   *  "More from season X" block on episode detail pages. */
  readonly hideControls = input(false);
  /** Optional override for the horizontal-scroller title. Defaults to
   *  the generic "Episodes" string when null. */
  readonly sectionTitle = input<string | null>(null);
  /** Episode the page is already showing — its card is framed instead of hidden. */
  readonly activeEpisodeId = input<number | null>(null);
  /** Season ids the viewer has liked — drives the season heart entry. */
  readonly likedSeasonIds = input<number[]>([]);

  /**
   * Card the rail should land on: the episode the page is showing, or the one
   * the viewer would resume otherwise. Centred from here rather than from the
   * page because the rail only exists once this component has rendered, and a
   * caller firing a frame after its own fetch finds nothing to scroll.
   */
  private readonly centerTarget = computed(() => {
    const active = this.activeEpisodeId();
    if (active != null) return active;
    const watched = this.watchedEpisodeIds();
    return (
      this.filteredEpisodes().find((e) => e.hasFile && !watched.has(e.id))?.id ?? null
    );
  });

  readonly selectSeason = output<number>();
  readonly episodesHasFileOnlyChange = output<boolean>();
  readonly loadSeasonReleases = output<Season>();
  readonly grabSeason = output<Season>();
  readonly toggleSeasonMonitored = output<Season>();
  readonly toggleSeasonWatched = output<{ season: Season; watched: boolean }>();
  readonly toggleEpisodeWatched = output<{ episode: Episode; watched: boolean }>();
  /** Viewer (regular requester) asks to (re-)request this season. */
  readonly requestSeason = output<Season>();
  /** Open the tracking-status modal for this season (emits the season number). */
  readonly viewSeasonTracking = output<number>();
  /** Toggle the viewer's like on this season (emits the season id). */
  readonly toggleSeasonLike = output<number>();
  /** Recommend this season to another member (emits the season id). */
  readonly recommendSeason = output<number>();
  readonly seasonWatchedBusyId = input<number | null>(null);

  // ── media.season.actions: the two release-picker entries in the season dropdown,
  // rendered from the contribution registry — core has none of its own here, so
  // with no plugin installed the list (and the dropdown rows) is empty.

  private readonly seasonActionsContext = computed<WhenContext>(() => ({
    isAdmin: this.isAdmin(),
    hasPermission: (p: string) => this.auth.hasPermission(p),
    mediaType: 'series',
    hasFiles: onDiskEpisodeNumbers(this.selectedSeason()?.episodes ?? []).size > 0,
    isMonitored: this.selectedSeason()?.monitored ?? false,
    hasQualityProfile: !!this.media().qualityProfile,
    isEpisode: false,
    isTv: this.tv.isTv(),
    isTouch: this.device.isTouch(),
  }));

  private readonly seasonActionHandlers: SeasonActionHandlers = {
    'season.search-releases': () => {
      const s = this.selectedSeason();
      if (s) this.loadSeasonReleases.emit(s);
    },
    'season.grab-best': () => {
      const s = this.selectedSeason();
      if (s) this.grabSeason.emit(s);
    },
  };

  /** Resolved season-dropdown rows: plugin contributions only, `when`-filtered, with
   *  the action resolved to a handler. An unknown actionId drops the row rather than
   *  rendering a broken one. */
  readonly seasonActionItems = computed(() => {
    const ctx = this.seasonActionsContext();
    const items: { id: string; labelKey: string; actionId: CoreSeasonActionId; handler: () => void }[] = [];
    for (const c of this.pluginUi.contributionsFor('media.season.actions')) {
      if (!evaluateWhen(c.when, ctx)) continue;
      if (c.action.kind !== 'action') continue;
      const handler = resolveSeasonAction(c.action.actionId, this.seasonActionHandlers);
      if (!handler) continue;
      items.push({ id: c.id, labelKey: c.labelKey, actionId: c.action.actionId as CoreSeasonActionId, handler });
    }
    return items;
  });

  /** Busy/disabled state per actionId: both a search and a grab only spin for the
   *  season they were started on, so grabs on other seasons can run alongside. */
  seasonActionPending(actionId: CoreSeasonActionId): boolean {
    const selectedId = this.selectedSeason()?.id;
    if (actionId === 'season.search-releases') {
      return this.seasonReleasesLoading() && this.seasonReleasesOpenId() === selectedId;
    }
    if (selectedId != null && this.seasonGrabBestBusyIds().has(selectedId)) return true;
    // A release picked by hand in the modal still locks the row it was picked from.
    return this.seasonGrabBusy() !== null;
  }

  /** Every episode with a file in the season is in the watched set. */
  seasonFullyWatched(season: Season | null): boolean {
    if (!season) return false;
    const watched = this.watchedEpisodeIds();
    let total = 0;
    for (const ep of season.episodes ?? []) {
      if (!ep.hasFile) continue;
      total++;
      if (!watched.has(ep.id)) return false;
    }
    return total > 0;
  }

  tabEpisodeCount(season: Season): number {
    return filterSeasonEpisodesOnDisk(season, this.episodesHasFileOnly()).length;
  }

  /** TVDB reports a bare year, which date formatting would widen into a day. */
  seasonAirDateIsYearOnly(season: Season): boolean {
    return /^\d{4}$/.test(season.airDate ?? '');
  }

  seasonWatchedCount(season: Season): number {
    const watched = this.watchedEpisodeIds();
    return (season.episodes ?? []).filter((ep) => watched.has(ep.id)).length;
  }

  /**
   * Card row or detail list. Kept local: nothing outside this component reacts
   * to it, unlike the on-disk filter the parent owns. Cards only on a TV, where
   * a vertical list has no idiom and the d-pad row does.
   */
  readonly episodeView = signal<EpisodeView>(readEpisodeViewFromStorage());
  readonly canSwitchEpisodeView = computed(
    () => !this.hideControls() && !this.tv.isTv(),
  );
  readonly showEpisodeList = computed(
    () => this.canSwitchEpisodeView() && this.episodeView() === 'list',
  );

  setEpisodeView(view: EpisodeView) {
    this.episodeView.set(view);
    try {
      localStorage.setItem(LS_EPISODE_VIEW, view);
    } catch {
      /* private mode / quota */
    }
  }

  /**
   * `05/08/2026 · 34 min`. Takes the date already formatted so the impure
   * locale pipe stays in the template and keeps re-running on a language switch.
   */
  episodeCardSubtitle(formattedDate: string, runtime?: number | null): string {
    const parts = [formattedDate || '—'];
    if (runtime) parts.push(`${runtime} ${this.translate.instant('common.min')}`);
    return parts.join(' · ');
  }

  /** True when at least one episode of the season isn't on disk — the
   *  prerequisite for surfacing a Demander entry. Uses coverage so a season
   *  fully covered by multi-episode files isn't flagged as missing. */
  seasonHasMissingEpisodes(season: Season | null): boolean {
    if (!season) return false;
    const onDisk = onDiskEpisodeNumbers(season.episodes ?? []);
    return (season.episodes ?? []).some(
      (ep) => !onDisk.has(ep.episodeNumber),
    );
  }

  /** True when the viewer already has an active request covering this
   *  season — Demander is hidden in that case. */
  seasonAlreadyRequested(season: Season | null): boolean {
    if (!season) return false;
    return this.userRequestedSeasonNumbers().includes(season.seasonNumber);
  }

  /** Évite d'afficher le panneau d'une saison masquée par le filtre disque. */
  isSeasonTabVisible(season: Season | null): boolean {
    if (!season) return false;
    return this.displaySeasons().some((s) => s.id === season.id);
  }

  trackedFilesForEpisode(episodeId: number) {
    return filesForEpisode(this.media().files, episodeId);
  }

  fileDiskPath(relativePath: string): string {
    return displayMediaFilePath(this.media().path, relativePath);
  }

  episodeBadgeLabel = episodeBadgeLabel;
  /** Grey still for an episode that hasn't aired, unless the viewer turned it off. */
  episodeStillSpoiler(ep: Episode): boolean {
    return this.spoilers.still(this.watchedEpisodeIds().has(ep.id));
  }

  /** A season's synopsis gives away episodes the viewer hasn't reached yet. */
  seasonOverviewSpoiler(season: Season): boolean {
    return this.spoilers.overview(this.seasonFullyWatched(season));
  }

  episodeOverviewSpoiler(ep: Episode): boolean {
    return this.spoilers.overview(this.watchedEpisodeIds().has(ep.id));
  }

  episodeTitle(ep: Episode): string {
    return this.spoilers.title(
      this.watchedEpisodeIds().has(ep.id),
      episodeBadgeLabel(ep),
      ep.title,
    );
  }

  /** Dimming marks the exception. With the series unmonitored every episode is, so dimming all
   *  of them says nothing and just makes the list harder to read. */
  episodeDimmed(ep: Episode): boolean {
    return this.media().monitored && !ep.monitored;
  }

  episodeGrayscale(ep: Episode): boolean {
    // The file settles it: an air date in the future is the source's view, and
    // the video can land before it.
    return (
      this.displaySettings.settings().grayUnreleased &&
      episodeUnreleased(ep) &&
      !ep.hasFile
    );
  }

  constructor() {
    effect(() => {
      const id = this.centerTarget();
      if (id == null) return;
      // Next frame: the cards this reads are rendered by the pass that ran
      // this effect, and the rail needs its final width to be centred.
      const season = this.selectedSeason()?.id;
      requestAnimationFrame(() =>
        centerRailOnCard(
          `episode-${id}`,
          season != null ? `season-${season}` : undefined,
        ),
      );
    });
  }

  episodeRoute(ep: Episode): string[] {
    return ['/series', String(this.media().id), 'episode', String(ep.id)];
  }

  addSeasonToPlaylist(season: Season) {
    this.addToPlaylist.open({ seasonId: season.id });
  }

  isSeasonLiked(seasonId: number): boolean {
    return this.likedSeasonIds().includes(seasonId);
  }

  playEpisode(ep: Episode) {
    const files = this.trackedFilesForEpisode(ep.id);
    if (!files.length) return;
    const m = this.media();
    void this.playableMedia.play({
      fileId: files[0].id,
      mediaId: m.id,
      episodeId: ep.id,
      title: m.title,
      episodeTitle: ep.title ?? undefined,
      fanartUrl: m.fanartUrl ?? null,
      stillUrl: ep.stillUrl ?? null,
      streamInfo: (files[0] as any).streamInfo,
    }, false);
  }
}
