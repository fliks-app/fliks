import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
import { MediaCardComponent } from '../../../../shared/components/media-card/media-card';
import { DropdownMenuComponent } from '../../../../shared/components/dropdown-menu';
import { DropdownOptionComponent } from '../../../../shared/components/dropdown-option/dropdown-option';
import { TvRowDirective } from '../../../../shared/directives/tv-row.directive';
import { ClampToggleDirective } from '../../../../shared/directives/clamp-toggle.directive';
import { CollapsibleSectionComponent } from '../../../../shared/components/collapsible-section/collapsible-section';
import {
  Episode,
  Media,
  Season,
} from '../../../../core/services/api/media.service';
import {
  displayMediaFilePath,
  episodeBadgeLabel,
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  onDiskEpisodeNumbers,
  seasonsVisibleWithDiskFilter,
} from '../../media-detail.utils';
import { PlayableMediaService } from '../../../../core/services/playable-media.service';
import { AddToPlaylistService } from '../../../../core/services/add-to-playlist.service';
import { TvService } from '../../../../core/services/tv.service';
import { AuthService } from '../../../../core/services/auth.service';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';

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
  imports: [TranslateModule, UpperCasePipe, NgTemplateOutlet, RouterLink, LocaleDatePipe, HorizontalScrollerComponent, CollapsibleSectionComponent, MediaCardComponent, DropdownMenuComponent, DropdownOptionComponent, TvRowDirective, ClampToggleDirective, LucideCheck, LucideClipboardList, LucideDownload, LucideEllipsisVertical, LucideEye, LucideEyeOff, LucideHeart, LucideLayoutGrid, LucideList, LucideListChecks, LucideListPlus, LucidePackage, LucideUserPlus, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-seasons.component.html',
})
export class MediaDetailSeasonsComponent {
  private readonly playableMedia = inject(PlayableMediaService);
  private readonly addToPlaylist = inject(AddToPlaylistService);
  private readonly translate = inject(TranslateService);
  readonly tv = inject(TvService);
  readonly auth = inject(AuthService);
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
  readonly seasonBusyId = input<number | null>(null);
  readonly watchedEpisodeIds = input<Set<number>>(new Set());
  readonly episodeProgress = input<Record<number, number>>({});
  readonly canGrab = input(false);
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
  /** Season ids the viewer has liked — drives the season heart entry. */
  readonly likedSeasonIds = input<number[]>([]);

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
