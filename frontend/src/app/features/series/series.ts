import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';
import { MediaService, Media } from '../../core/services/api/media.service';
import { ProfilesService, QualityProfile } from '../../core/services/api/profiles.service';
import { MediaCardComponent } from '../../shared/components/media-card';

const ALPHABET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

@Component({
  selector: 'app-series',
  imports: [MediaCardComponent, FormsModule, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './series.html',
})
export class SeriesComponent implements OnInit {
  private readonly mediaService = inject(MediaService);
  private readonly profilesService = inject(ProfilesService);

  readonly allSeries = signal<Media[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  readonly searchQuery = signal('');
  readonly sortBy = signal('title');
  readonly filterMonitored = signal<'' | 'true' | 'false'>('');
  readonly filterStatus = signal<'' | 'missing' | 'cutoffUnmet'>('');

  readonly monitoredCount = computed(() => this.allSeries().filter((m) => m.monitored).length);
  readonly totalEpisodes = computed(() =>
    this.allSeries().reduce((sum, m) => sum + (m.episodeStats?.totalEpisodes ?? 0), 0),
  );
  readonly downloadedEpisodes = computed(() =>
    this.allSeries().reduce((sum, m) => sum + (m.episodeStats?.downloadedEpisodes ?? 0), 0),
  );

  readonly alphabet = ALPHABET;
  readonly activeLetter = signal('');

  // Bulk editing
  readonly selectedIds = signal<Set<number>>(new Set());
  readonly bulkMode = signal(false);
  readonly bulkSaving = signal(false);
  readonly bulkQualityProfileId = signal<number | null>(null);
  readonly bulkMonitored = signal<'' | 'true' | 'false'>('');
  readonly qualityProfiles = signal<QualityProfile[]>([]);

  ngOnInit() {
    this.load();
    this.profilesService.getQualityProfiles().then((p) => this.qualityProfiles.set(p));
  }

  scrollToLetter(letter: string) {
    this.activeLetter.set(letter);
    const items = this.allSeries();
    const index = items.findIndex((m) => {
      const firstChar = (m.title || '').charAt(0).toUpperCase();
      if (letter === '#') return !/[A-Z]/.test(firstChar);
      return firstChar === letter;
    });
    if (index < 0) return;
    const target = document.getElementById(`series-${items[index].id}`);
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  onSearch(query: string) {
    this.searchQuery.set(query);
    this.load();
  }

  onFilterChange() {
    this.load();
  }

  toggleSelect(id: number) {
    this.selectedIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  selectAll() {
    this.selectedIds.set(new Set(this.allSeries().map((m) => m.id)));
  }

  deselectAll() {
    this.selectedIds.set(new Set());
  }

  toggleBulkMode() {
    this.bulkMode.update((v) => !v);
    if (!this.bulkMode()) {
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
    }
  }

  async applyBulk() {
    const ids = [...this.selectedIds()];
    if (!ids.length) return;

    const body: Parameters<MediaService['bulkUpdate']>[0] = { ids };
    if (this.bulkQualityProfileId() !== null) {
      body.qualityProfileId = this.bulkQualityProfileId()!;
    }
    if (this.bulkMonitored() !== '') {
      body.monitored = this.bulkMonitored() === 'true';
    }

    this.bulkSaving.set(true);
    try {
      await this.mediaService.bulkUpdate(body);
      this.selectedIds.set(new Set());
      this.bulkQualityProfileId.set(null);
      this.bulkMonitored.set('');
      this.bulkMode.set(false);
      await this.load();
    } finally {
      this.bulkSaving.set(false);
    }
  }

  private async load() {
    this.loading.set(true);
    const monitored = this.filterMonitored();
    try {
      const res = await this.mediaService.getAll({
        type: 'series',
        q: this.searchQuery() || undefined,
        sortBy: this.sortBy(),
        monitored: monitored ? monitored === 'true' : undefined,
        missing: this.filterStatus() === 'missing' ? true : undefined,
        cutoffUnmet: this.filterStatus() === 'cutoffUnmet' ? true : undefined,
        limit: 0,
      });
      this.allSeries.set(res.data);
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
