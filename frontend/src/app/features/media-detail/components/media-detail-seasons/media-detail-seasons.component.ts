import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { UpperCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { LucideCheck, LucideEllipsisVertical, LucideX } from '@lucide/angular';
import { HorizontalScrollerComponent } from '../../../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../../../shared/components/media-card/media-card';
import { ResolveUrlPipe } from '../../../../core/pipes/resolve-url.pipe';
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
  seasonsVisibleWithDiskFilter,
} from '../../media-detail.utils';
import { METADATA_PROVIDER_OPTIONS_OVERRIDE } from '../../../../core/constants/metadata-providers';


@Component({
  selector: 'app-media-detail-seasons',
  imports: [TranslateModule, FormsModule, RouterLink, ResolveUrlPipe, UpperCasePipe, HorizontalScrollerComponent, MediaCardComponent, LucideCheck, LucideEllipsisVertical, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-seasons.component.html',
})
export class MediaDetailSeasonsComponent {
  private readonly router = inject(Router);
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
  /** Hide the action bar (season select, bulk actions). Used by the
   *  "More from season X" block on episode detail pages. */
  readonly hideControls = input(false);
  /** Optional override for the horizontal-scroller title. Defaults to
   *  the generic "Episodes" string when null. */
  readonly sectionTitle = input<string | null>(null);

  readonly selectSeason = output<number>();
  readonly episodesHasFileOnlyChange = output<boolean>();
  readonly loadSeasonReleases = output<Season>();
  readonly grabSeason = output<Season>();
  readonly toggleSeasonMonitored = output<Season>();
  readonly toggleSeasonWatched = output<{ season: Season; watched: boolean }>();
  readonly toggleEpisodeWatched = output<{ episode: Episode; watched: boolean }>();
  readonly setSeasonProvider = output<{
    season: Season;
    provider: 'tmdb' | 'tvdb' | null;
  }>();
  readonly seasonWatchedBusyId = input<number | null>(null);

  readonly providerOptions = METADATA_PROVIDER_OPTIONS_OVERRIDE;

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
    return filterSeasonEpisodesOnDisk(season, this.media(), this.episodesHasFileOnly()).length;
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

  playEpisode(ep: Episode) {
    const files = this.trackedFilesForEpisode(ep.id);
    if (files.length) {
      const m = this.media();
      // Detour via '/' forces Angular to remount the player component
      // (same-route navigation reuses the component without re-reading params).
      void this.router
        .navigateByUrl('/', { skipLocationChange: true })
        .then(() =>
          this.router.navigate(['/watch', files[0].id], {
            queryParams: { mediaId: m.id, episodeId: ep.id },
          }),
        );
    }
  }
}
