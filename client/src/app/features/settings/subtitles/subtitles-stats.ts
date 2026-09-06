import {
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideSearch } from '@lucide/angular';
import { TranslatePipe } from '@ngx-translate/core';
import {
  SubtitlesApiService,
  SubtitleStats,
  MissingSubtitleEntry,
} from '../../../core/services/api/subtitles-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';

@Component({
  selector: 'app-subtitles-stats',
  imports: [LucideSearch, RouterLink, TranslatePipe, PaginationComponent],
  templateUrl: './subtitles-stats.html',
})
export class SubtitlesStatsComponent implements OnInit {
  private readonly api = inject(SubtitlesApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly loading = signal(true);
  readonly searchBusy = signal<string | null>(null);
  readonly stats = signal<SubtitleStats | null>(null);
  readonly missing = signal<MissingSubtitleEntry[]>([]);

  /** Server-reported total, not the page length. */
  readonly missingTotal = signal(0);
  readonly missingCount = computed(() => this.missingTotal());

  private readonly statusLabels: Record<string, string> = {
    downloaded: 'Téléchargés',
    synced: 'Synchronisés',
    upgraded: 'Améliorés',
    failed: 'Échoués',
    missing: 'Manquants',
    embedded: 'Intégrés',
  };

  statusLabel(key: string): string {
    return this.statusLabels[key] ?? key;
  }

  readonly statusEntries = computed(() => {
    const s = this.stats();
    if (!s) return [];
    return Object.entries(s.byStatus).sort((a, b) => b[1] - a[1]);
  });
  readonly providerEntries = computed(() => {
    const s = this.stats();
    if (!s) return [];
    return Object.entries(s.byProvider).sort((a, b) => b[1] - a[1]);
  });

  readonly pageSize = 20;
  readonly page = signal(0);
  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.missingTotal() / this.pageSize)),
  );

  async goToPage(p: number) {
    this.page.set(Math.max(0, Math.min(p, this.totalPages() - 1)));
    await this.loadMissing();
  }

  private async loadMissing() {
    const { total, data } = await this.api.getMissing(this.page() + 1, this.pageSize);
    this.missingTotal.set(total);
    this.missing.set(data);
  }

  rowKey(row: MissingSubtitleEntry): string {
    return `${row.fileId}-${row.language}`;
  }

  async searchOne(row: MissingSubtitleEntry) {
    const key = this.rowKey(row);
    this.searchBusy.set(key);
    try {
      const result = await this.api.autoDownload(row.mediaId, {
        mediaFileId: row.fileId,
        episodeId: row.episodeId ?? undefined,
        language: row.language,
      });
      if (result) {
        this.missing.update((list) =>
          list.filter((r) => !(r.fileId === row.fileId && r.language === row.language)),
        );
        this.missingTotal.update((t) => Math.max(0, t - 1));
        this.toast.success(
          this.translate.instant('settings.subtitles.search_one_ok', {
            lang: row.language,
            title: row.mediaTitle,
          }),
        );
      } else {
        this.toast.info(
          this.translate.instant('settings.subtitles.search_one_none', {
            lang: row.language,
          }),
        );
      }
    } catch {
      // handled by global interceptor
    } finally {
      this.searchBusy.set(null);
    }
  }

  async ngOnInit() {
    try {
      const [stats] = await Promise.all([this.api.getStats(), this.loadMissing()]);
      this.stats.set(stats);
    } catch {
      // handled by global interceptor
    } finally {
      this.loading.set(false);
    }
  }
}
