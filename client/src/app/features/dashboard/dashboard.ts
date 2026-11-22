import {
  Component,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { TranslatePipe } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SubtitlesApiService, SubtitleStats } from '../../core/services/api/subtitles-api.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';
import { episodeLabel } from '../../shared/utils/episode-label';
import { MediaLinkPipe } from '../../core/pipes/media-link.pipe';
import { formatBytes } from '../../core/utils/format-bytes';

interface DiskSpaceEntry {
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
}

interface StatsReport {
  movies: number;
  series: number;
  pendingRequests: number;
  diskSpace: DiskSpaceEntry[];
}

@Component({
  selector: 'app-dashboard',
  imports: [MediaLinkPipe, RouterLink, TranslatePipe, LocaleDatePipe],
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly subtitlesApi = inject(SubtitlesApiService);

  readonly episodeLabel = episodeLabel;

  readonly stats = signal<StatsReport | null>(null);
  readonly subStats = signal<SubtitleStats | null>(null);
  readonly loading = signal(true);

  async ngOnInit() {
    try {
      const [data, subData] = await Promise.all([
        firstValueFrom(this.http.get<StatsReport>('/api/system/stats')),
        this.subtitlesApi.getStats().catch(() => null),
      ]);
      this.stats.set(data);
      this.subStats.set(subData);
    } finally {
      this.loading.set(false);
    }
  }

  protected readonly formatBytes = formatBytes;

  diskUsedPercent(entry: DiskSpaceEntry): number {
    if (entry.totalSpace <= 0) return 0;
    return Math.round(((entry.totalSpace - entry.freeSpace) / entry.totalSpace) * 100);
  }
}
