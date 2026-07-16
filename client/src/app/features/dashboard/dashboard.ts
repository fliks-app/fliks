import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { TranslateModule } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SubtitlesApiService, SubtitleStats } from '../../core/services/api/subtitles-api.service';
import { LocaleDatePipe } from '../../core/pipes/locale-date.pipe';

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
  imports: [RouterLink, TranslateModule, LocaleDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly subtitlesApi = inject(SubtitlesApiService);

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

  formatBytes(bytes: number): string {
    if (bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i >= 3 ? 1 : 0)} ${units[i]}`;
  }

  diskUsedPercent(entry: DiskSpaceEntry): number {
    if (entry.totalSpace <= 0) return 0;
    return Math.round(((entry.totalSpace - entry.freeSpace) / entry.totalSpace) * 100);
  }
}
