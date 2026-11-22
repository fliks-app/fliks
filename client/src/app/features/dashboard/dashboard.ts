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
import { NeedsAttentionComponent } from '../../shared/components/needs-attention/needs-attention';
import { CountsApiService } from '../../core/services/api/counts-api.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';

interface DiskSpaceEntry {
  path: string;
  label: string | null;
  freeSpace: number;
  totalSpace: number;
}

interface StatsReport {
  pendingRequests: number;
  diskSpace: DiskSpaceEntry[];
}

interface LibraryTile {
  id: number;
  name: string;
  count: number;
}

@Component({
  selector: 'app-dashboard',
  imports: [MediaLinkPipe, RouterLink, TranslatePipe, LocaleDatePipe, NeedsAttentionComponent],
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly countsApi = inject(CountsApiService);
  private readonly librariesApi = inject(LibrariesApiService);

  readonly episodeLabel = episodeLabel;

  readonly stats = signal<StatsReport | null>(null);
  readonly subStats = signal<SubtitleStats | null>(null);
  readonly libraryTiles = signal<LibraryTile[]>([]);
  readonly loading = signal(true);
  readonly skeletonTiles = [0, 1, 2, 3];

  async ngOnInit() {
    try {
      const [data, subData, counts, libraries] = await Promise.all([
        firstValueFrom(this.http.get<StatsReport>('/api/system/stats')),
        this.subtitlesApi.getStats().catch(() => null),
        this.countsApi.get().catch(() => null),
        this.librariesApi.listMine().catch(() => []),
      ]);
      this.stats.set(data);
      this.subStats.set(subData);
      this.libraryTiles.set(
        libraries.map((l) => ({ id: l.id, name: l.name, count: counts?.mediaByLibrary[l.id] ?? 0 })),
      );
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
