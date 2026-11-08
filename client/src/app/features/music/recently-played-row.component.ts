import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import { MediaLinkPipe } from '../../core/pipes/media-link.pipe';
import type { Media } from '../../core/services/api/media.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { AlbumListInfo } from '../../core/services/api/music.models';
import { HorizontalScrollerComponent } from '../../shared/components/horizontal-scroller';
import { MediaCardComponent } from '../../shared/components/media-card/media-card';
import { artistLine } from './music-utils';

type AlbumRow = Media & { album?: AlbumListInfo };

/** The albums the viewer played last; draws nothing when there are none or the request fails. */
@Component({
  selector: 'app-recently-played-row',
  imports: [TranslatePipe, MediaLinkPipe, HorizontalScrollerComponent, MediaCardComponent],
  templateUrl: './recently-played-row.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecentlyPlayedRowComponent {
  protected readonly albums = signal<AlbumRow[]>([]);

  constructor() {
    inject(MusicApiService)
      .recentlyPlayed()
      .then((a) => this.albums.set(a as AlbumRow[]))
      .catch(() => {});
  }

  protected artists(m: AlbumRow): string | undefined {
    return m.album ? artistLine(m.album.artists.map((a) => ({ name: a.name, creditedName: null, joinPhrase: null }))) : undefined;
  }
}
