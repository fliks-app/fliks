import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { HorizontalScrollerComponent } from '../../../../shared/components/horizontal-scroller';
import {
  Episode,
  Media,
  Season,
} from '../../../../core/services/api/media.service';
import {
  displayMediaFilePath,
  filesForEpisode,
  filterSeasonEpisodesOnDisk,
  seasonsVisibleWithDiskFilter,
} from '../../media-detail.utils';


@Component({
  selector: 'app-media-detail-seasons',
  imports: [TranslateModule, RouterLink, HorizontalScrollerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './media-detail-seasons.component.html',
})
export class MediaDetailSeasonsComponent {
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
  readonly canGrab = input(false);
  readonly isAdmin = input(false);

  readonly selectSeason = output<number>();
  readonly episodesHasFileOnlyChange = output<boolean>();
  readonly loadSeasonReleases = output<Season>();
  readonly grabSeason = output<Season>();
  readonly toggleSeasonMonitored = output<Season>();

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

  episodeRoute(ep: Episode): string[] {
    return ['/series', String(this.media().id), 'episode', String(ep.id)];
  }
}
