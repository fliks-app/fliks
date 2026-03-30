import { Component, ChangeDetectionStrategy, signal, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { MediaCardComponent } from '../../shared/components/media-card';

@Component({
  selector: 'app-movies',
  imports: [MediaCardComponent, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './movies.html',
})
export class MoviesComponent implements OnInit {
  private readonly mediaService = inject(MediaService);

  readonly movies = signal<Media[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly filterMonitored = signal<'' | 'true' | 'false'>('');
  private page = 1;

  readonly monitoredCount = computed(() => this.movies().filter((m) => m.monitored).length);
  readonly movieFileCount = computed(() => this.movies().filter((m) => (m.files?.length ?? 0) > 0).length);

  ngOnInit() {
    this.load();
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.reset();
  }

  onFilterChange() {
    this.reset();
  }

  loadMore() {
    this.page++;
    this.load(true);
  }

  private reset() {
    this.page = 1;
    this.movies.set([]);
    this.load();
  }

  private async load(append = false) {
    this.loading.set(true);
    const monitored = this.filterMonitored();
    try {
      const res = await this.mediaService.getAll({
        type: 'movie',
        q: this.searchQuery() || undefined,
        sortBy: this.sortBy(),
        monitored: monitored ? monitored === 'true' : undefined,
        page: this.page,
        limit: 24,
      });
      this.movies.update((prev) =>
        append ? [...prev, ...res.data] : res.data,
      );
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
