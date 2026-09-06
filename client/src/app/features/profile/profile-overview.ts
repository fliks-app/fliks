import {
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { MosaicCardComponent } from '../../shared/components/mosaic-card/mosaic-card';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { PublicProfile } from '../../core/services/api/social-api.service';
import { MetadataService, TmdbGenre } from '../../core/services/api/metadata.service';
import { SearchStateService } from '../../core/services/search-state.service';
import { resolveTmdbGenreId } from '../../core/utils/tmdb-genres';
import { ProfileContextService } from './profile-context.service';
import { itemArtwork } from '../../shared/utils/media-artwork.util';

/** The profile "overview" tab: tastes, playlists, recommendations, recently
 *  watched and likes, each behind its share toggle. Reads the profile aggregate
 *  from {@link ProfileContextService} (loaded by the parent shell). */
@Component({
  selector: 'app-profile-overview',
  imports: [
    TranslatePipe,
    MosaicCardComponent,
    MediaCardComponent,
    HorizontalScrollerComponent,
  ],
  templateUrl: './profile-overview.html',
})
export class ProfileOverviewComponent {
  private readonly router = inject(Router);
  private readonly metadata = inject(MetadataService);
  private readonly searchState = inject(SearchStateService);
  protected readonly ctx = inject(ProfileContextService);
  protected readonly itemArtwork = itemArtwork;

  readonly profile = this.ctx.profile;

  /** TMDB genre lists in the server language (movie first so shared genres
   *  resolve to a movie id, which the discover grid can filter on). */
  private readonly genreList = signal<TmdbGenre[]>([]);

  /** Taste chips resolved to a TMDB id + the server-language name, deduped.
   *  Stored genre names can be a mix of languages on older items; resolving to
   *  an id lets us relabel them consistently and filter reliably. */
  readonly displayGenres = computed<{ id: number; name: string }[]>(() => {
    const list = this.genreList();
    const out: { id: number; name: string }[] = [];
    const seen = new Set<number>();
    for (const g of this.profile()?.topGenres ?? []) {
      const id = resolveTmdbGenreId(g.genre, list);
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: list.find((x) => x.id === id)?.name ?? g.genre });
    }
    return out;
  });

  constructor() {
    void this.loadGenres();
  }

  private async loadGenres(): Promise<void> {
    try {
      const [movie, tv] = await Promise.all([
        this.metadata.getMovieGenres().catch(() => [] as TmdbGenre[]),
        this.metadata.getTvGenres().catch(() => [] as TmdbGenre[]),
      ]);
      this.genreList.set([...movie, ...tv]);
    } catch {
      /* chips fall back to the static alias resolver */
    }
  }

  /** Open the general search page with the discover panel preloaded on a genre
   *  id (language-proof), not a library-scoped view. */
  openGenre(id: number): void {
    this.searchState.requestGenreFilter(id);
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
