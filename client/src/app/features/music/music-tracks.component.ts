import { ChangeDetectionStrategy, Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { LucidePlay } from '@lucide/angular';
import { AudioPlayerService } from '../../core/services/audio-player/audio-player.service';
import { MusicApiService } from '../../core/services/api/music-api.service';
import type { TrackRow, TracksQuery } from '../../core/services/api/music.models';
import { TvSelectDirective } from '../../shared/directives/tv-select.directive';
import { artistLine, formatDuration, toTrackRequest } from './music-utils';
import { PagedList } from './paged-list';
import { TrackLineComponent } from './track-line.component';

const PAGE = 50;
type Sort = NonNullable<TracksQuery['sortBy']>;

/** Every track of a library, searchable and sortable; a click plays the list from that track. */
@Component({
  selector: 'app-music-tracks',
  imports: [FormsModule, RouterLink, TranslatePipe, TvSelectDirective, TrackLineComponent, LucidePlay],
  templateUrl: './music-tracks.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicTracksComponent {
  readonly libraryId = input<number | undefined>(undefined);

  private readonly api = inject(MusicApiService);
  private readonly player = inject(AudioPlayerService);
  protected readonly query = signal('');
  protected readonly sortBy = signal<Sort>('title');
  protected readonly filter = signal<'' | 'favourite' | 'rated'>('');
  protected readonly sorts: Sort[] = ['title', 'album', 'added', 'played', 'rating'];
  protected readonly fmt = formatDuration;
  protected readonly line = artistLine;
  protected readonly list = new PagedList<TrackRow>((page) => {
    const sortBy = this.sortBy();
    return this.api.tracks({
      libraryId: this.libraryId(),
      q: this.query() || undefined,
      favourite: this.filter() === 'favourite',
      rated: this.filter() === 'rated',
      sortBy,
      sortOrder: sortBy === 'title' || sortBy === 'album' ? 'asc' : 'desc',
      page,
      limit: PAGE,
    });
  }, PAGE);

  constructor() {
    effect((onCleanup) => {
      this.libraryId();
      this.sortBy();
      this.filter();
      const q = this.query();
      const t = setTimeout(() => untracked(() => void this.list.load()), q ? 300 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected play(index: number): Promise<void> {
    const rows = this.list.rows();
    const playable = rows.filter((r) => r.hasFile);
    const start = playable.indexOf(rows[index]!);
    return this.player.playTracks(
      playable.map((r) =>
        toTrackRequest(r, { mediaId: r.mediaId, title: r.albumTitle, coverUrl: r.posterUrl, artists: '', albumGain: null, albumPeak: null }),
      ),
      Math.max(0, start),
    );
  }
}
