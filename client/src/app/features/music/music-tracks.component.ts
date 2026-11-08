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

const PAGE = 50;
type Sort = NonNullable<TracksQuery['sortBy']>;

/** Every track of a library, searchable and sortable; a click plays the list from that track. */
@Component({
  selector: 'app-music-tracks',
  imports: [FormsModule, RouterLink, TranslatePipe, TvSelectDirective, LucidePlay],
  templateUrl: './music-tracks.component.html',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MusicTracksComponent {
  readonly libraryId = input<number | undefined>(undefined);

  private readonly api = inject(MusicApiService);
  private readonly player = inject(AudioPlayerService);
  protected readonly rows = signal<TrackRow[]>([]);
  protected readonly query = signal('');
  protected readonly sortBy = signal<Sort>('title');
  protected readonly filter = signal<'' | 'favourite' | 'rated'>('');
  protected readonly loading = signal(false);
  protected readonly more = signal(false);
  protected readonly sorts: Sort[] = ['title', 'album', 'added', 'played', 'rating'];
  protected readonly fmt = formatDuration;
  protected readonly line = artistLine;
  private generation = 0;

  constructor() {
    effect((onCleanup) => {
      this.libraryId();
      this.sortBy();
      this.filter();
      const q = this.query();
      const t = setTimeout(() => untracked(() => void this.load(false)), q ? 300 : 0);
      onCleanup(() => clearTimeout(t));
    });
  }

  protected loadMore(): void {
    void this.load(true);
  }

  protected play(index: number): Promise<void> {
    const playable = this.rows().filter((r) => r.hasFile);
    const start = playable.indexOf(this.rows()[index]!);
    return this.player.playTracks(
      playable.map((r) =>
        toTrackRequest(r, { mediaId: r.mediaId, title: r.albumTitle, coverUrl: r.posterUrl, artists: '', albumGain: null, albumPeak: null }),
      ),
      Math.max(0, start),
    );
  }

  private async load(append: boolean): Promise<void> {
    const gen = ++this.generation;
    this.loading.set(true);
    const f = this.filter();
    const sortBy = this.sortBy();
    try {
      const got = await this.api.tracks({
        libraryId: this.libraryId(),
        q: this.query() || undefined,
        favourite: f === 'favourite',
        rated: f === 'rated',
        sortBy,
        sortOrder: sortBy === 'title' || sortBy === 'album' ? 'asc' : 'desc',
        page: append ? Math.floor(this.rows().length / PAGE) + 1 : 1,
        limit: PAGE,
      });
      if (gen !== this.generation) return;
      this.rows.set(append ? [...this.rows(), ...got] : got);
      this.more.set(got.length === PAGE);
    } catch {
      if (gen === this.generation && !append) this.rows.set([]);
    } finally {
      if (gen === this.generation) this.loading.set(false);
    }
  }
}
