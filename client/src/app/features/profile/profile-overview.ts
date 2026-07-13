import {
  ChangeDetectionStrategy,
  Component,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { PublicProfile } from '../../core/services/api/social-api.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { ProfileContextService } from './profile-context.service';

/** The profile "overview" tab: tastes, playlists, recommendations, recently
 *  watched and likes, each behind its share toggle. Reads the profile aggregate
 *  from {@link ProfileContextService} (loaded by the parent shell). */
@Component({
  selector: 'app-profile-overview',
  imports: [
    TranslateModule,
    MosaicCardComponent,
    MediaCardComponent,
    HorizontalScrollerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-overview.html',
})
export class ProfileOverviewComponent {
  private readonly router = inject(Router);
  private readonly searchState = inject(SearchStateService);
  protected readonly ctx = inject(ProfileContextService);

  readonly profile = this.ctx.profile;

  /** Open the general search page with the discover panel preloaded on a
   *  genre (not a library-scoped view). */
  openGenre(genre: string): void {
    this.searchState.requestGenreFilter(genre);
    void this.router.navigate(['/search']);
  }

  mediaLink(mediaType: string, mediaId: number): string[] {
    return [mediaType === 'series' ? '/series' : '/movies', String(mediaId)];
  }

  /** Route to a liked item: the episode page when it targets an episode,
   *  otherwise the movie or series detail page. */
  likeLink(item: { mediaType: string; mediaId: number; episodeId: number | null }): string[] {
    if (item.episodeId) {
      return ['/series', String(item.mediaId), 'episode', String(item.episodeId)];
    }
    return this.mediaLink(item.mediaType, item.mediaId);
  }

  /** True when at least one visible section has something to show. */
  hasContent(p: PublicProfile): boolean {
    return (
      p.playlists.length > 0 ||
      (p.shown.tastes && p.topGenres.length > 0) ||
      (p.shown.recommendations && p.recommendations.length > 0) ||
      (p.shown.recentlyWatched && p.recentlyWatched.length > 0) ||
      (p.shown.likes && p.likes.length > 0)
    );
  }

  openPlaylist(id: number): void {
    void this.router.navigate(['/playlists', id]);
  }
}
