import { Component, ChangeDetectionStrategy, signal, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { MediaCardComponent } from '../../shared/components/media-card';

@Component({
  selector: 'app-series',
  imports: [MediaCardComponent, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './series.html',
})
export class SeriesComponent implements OnInit {
  private readonly mediaService = inject(MediaService);

  readonly series = signal<Media[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly filterMonitored = signal<'' | 'true' | 'false'>('');
  private page = 1;

  readonly monitoredCount = computed(() => this.series().filter((m) => m.monitored).length);
  readonly totalEpisodes = computed(() =>
    this.series().reduce((sum, m) => sum + (m.episodeStats?.totalEpisodes ?? 0), 0),
  );
  readonly downloadedEpisodes = computed(() =>
    this.series().reduce((sum, m) => sum + (m.episodeStats?.downloadedEpisodes ?? 0), 0),
  );

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
    this.series.set([]);
    this.load();
  }

  private async load(append = false) {
    this.loading.set(true);
    const monitored = this.filterMonitored();
    try {
      const res = await this.mediaService.getAll({
        type: 'series',
        q: this.searchQuery() || undefined,
        sortBy: this.sortBy(),
        monitored: monitored ? monitored === 'true' : undefined,
        page: this.page,
        limit: 24,
      });
      this.series.update((prev) =>
        append ? [...prev, ...res.data] : res.data,
      );
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
