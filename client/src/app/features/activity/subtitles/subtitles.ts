import {
  Component,
  ChangeDetectionStrategy,
  signal,
  inject,
  OnInit,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  SubtitlesApiService,
  SubtitleHistoryEntry,
} from '../../../core/services/api/subtitles-api.service';
import { PaginationComponent } from '../../../shared/components/pagination/pagination';
import { LocaleDatePipe } from '../../../core/pipes/locale-date.pipe';

@Component({
  selector: 'app-activity-subtitles',
  imports: [TranslateModule, LocaleDatePipe, NgClass, RouterLink, FormsModule, PaginationComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './subtitles.html',
})
export class ActivitySubtitlesComponent implements OnInit {
  private readonly subtitlesApi = inject(SubtitlesApiService);
  private readonly translate = inject(TranslateService);

  readonly subHistory = signal<SubtitleHistoryEntry[]>([]);
  readonly subHistoryTotal = signal(0);
  readonly subHistoryPage = signal(1);
  readonly subHistoryLoading = signal(false);
  readonly subHistoryError = signal('');
  readonly subFilterStatus = signal('');
  readonly subFilterLang = signal('');

  ngOnInit() {
    this.loadSubHistory(1);
  }

  async loadSubHistory(page = 1) {
    this.subHistoryPage.set(page);
    this.subHistoryLoading.set(true);
    this.subHistoryError.set('');
    try {
      const params: Record<string, any> = { page, limit: 25, excludeEmbedded: true };
      if (this.subFilterStatus()) params['status'] = this.subFilterStatus();
      if (this.subFilterLang()) params['language'] = this.subFilterLang();
      const res = await this.subtitlesApi.getHistory(params);
      this.subHistory.set(res.data);
      this.subHistoryTotal.set(res.total);
    } catch {
      this.subHistoryError.set(this.translate.instant('activity.subtitle_history_error'));
    } finally {
      this.subHistoryLoading.set(false);
    }
  }

  applySubFilters() {
    this.loadSubHistory(1);
  }

  get subHistoryTotalPages(): number {
    return Math.max(1, Math.ceil(this.subHistoryTotal() / 25));
  }

  subStatusClass(status: string): string {
    switch (status) {
      case 'downloaded': case 'synced': return 'badge-success';
      case 'upgraded': return 'badge-warning';
      case 'failed': return 'badge-error';
      default: return 'badge-ghost';
    }
  }
}
