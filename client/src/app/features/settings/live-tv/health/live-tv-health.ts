import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { TranslatePipe } from '@ngx-translate/core';
import {
  LiveTvApiService,
  AdminSource,
  AdminChannel,
  AdminChannelStream,
} from '../../../../core/services/api/livetv-api.service';
import { PaginationComponent } from '../../../../shared/components/pagination/pagination';
import { ErrorBadgeComponent } from '../../../../shared/components/error-badge';
import { LocaleDatePipe } from '../../../../core/pipes/locale-date.pipe';

const PAGE_SIZE = 25;
/** One request covers a real lineup; paginate server-side if that stops being true. */
const CHANNEL_SCAN_PAGE_SIZE = 2000;

interface ChannelHealthRow {
  channel: AdminChannel;
  streams: { stream: AdminChannelStream; sourceName: string }[];
}

function sourceHealthScore(s: AdminSource): number {
  if (s.lastSyncStatus === 'error') return 2;
  if (s.lastSyncStatus === 'never') return 1;
  return 0;
}

function channelHealthScore(c: AdminChannel): number {
  const errorAt = c.lastErrorAt ? new Date(c.lastErrorAt).getTime() : 0;
  return c.consecutiveFailures * 1e15 + errorAt;
}

@Component({
  selector: 'app-live-tv-health',
  imports: [TranslatePipe, PaginationComponent, LocaleDatePipe, ErrorBadgeComponent],
  templateUrl: './live-tv-health.html',
})
export class LiveTvHealthComponent implements OnInit {
  private readonly api = inject(LiveTvApiService);

  readonly sourcesLoading = signal(true);
  readonly sources = signal<AdminSource[]>([]);
  readonly sourcesSorted = computed(() => [...this.sources()].sort((a, b) => sourceHealthScore(b) - sourceHealthScore(a)));

  readonly channelsLoading = signal(true);
  private readonly channels = signal<AdminChannel[]>([]);
  private readonly sourceNameById = computed(() => new Map(this.sources().map((s) => [s.id, s.name])));

  readonly channelRows = computed<ChannelHealthRow[]>(() => {
    const names = this.sourceNameById();
    return [...this.channels()]
      .sort((a, b) => channelHealthScore(b) - channelHealthScore(a))
      .map((channel) => ({
        channel,
        streams: (channel.streams ?? []).map((stream) => ({
          stream,
          sourceName: names.get(stream.sourceId) ?? '?',
        })),
      }));
  });

  readonly page = signal(1);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.channelRows().length / PAGE_SIZE)));
  readonly pageRows = computed(() => {
    const start = (this.page() - 1) * PAGE_SIZE;
    return this.channelRows().slice(start, start + PAGE_SIZE);
  });

  ngOnInit(): void {
    void this.loadSources();
    void this.loadChannels();
  }

  private async loadSources(): Promise<void> {
    this.sourcesLoading.set(true);
    try {
      this.sources.set(await this.api.listSources());
    } catch {
      // handled by the global error interceptor
    } finally {
      this.sourcesLoading.set(false);
    }
  }

  private async loadChannels(): Promise<void> {
    this.channelsLoading.set(true);
    try {
      const res = await this.api.listAdminChannels({ page: 1, pageSize: CHANNEL_SCAN_PAGE_SIZE });
      this.channels.set(res.items ?? []);
    } catch {
      // handled by the global error interceptor
    } finally {
      this.channelsLoading.set(false);
    }
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.page.set(page);
  }
}
