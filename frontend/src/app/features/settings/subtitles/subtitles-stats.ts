import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import {
  SubtitlesApiService,
  SubtitleStats,
  MissingSubtitleEntry,
} from '../../../core/services/api/subtitles-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { TranslateService } from '@ngx-translate/core';

@Component({
  selector: 'app-subtitles-stats',
  imports: [RouterLink, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  readonly missingCount = computed(() => this.missing().length);

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
    Math.max(1, Math.ceil(this.missing().length / this.pageSize)),
  );
  readonly pagedMissing = computed(() => {
    const start = this.page() * this.pageSize;
    return this.missing().slice(start, start + this.pageSize);
  });

  goToPage(p: number) {
    this.page.set(Math.max(0, Math.min(p, this.totalPages() - 1)));
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
      const [stats, missing] = await Promise.all([
        this.api.getStats(),
        this.api.getMissing(),
      ]);
      this.stats.set(stats);
      this.missing.set(missing);
    } catch {
      // handled by global interceptor
    } finally {
      this.loading.set(false);
    }
  }
}
