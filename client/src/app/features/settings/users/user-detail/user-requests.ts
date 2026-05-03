import {
  Component,
  ChangeDetectionStrategy,
  signal,
  computed,
  inject,
  OnInit,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import {
  RequestsService,
  FliksRequestRow,
} from '../../../../core/services/api/requests.service';
import { UserDetailState } from './user-detail.state';

@Component({
  selector: 'app-user-requests',
  imports: [DatePipe, TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-requests.html',
})
export class UserRequestsComponent implements OnInit {
  private readonly requestsApi = inject(RequestsService);
  private readonly state = inject(UserDetailState);

  readonly requests = signal<FliksRequestRow[]>([]);
  readonly total = signal(0);
  readonly loading = signal(false);
  private page = 1;

  readonly hasMore = computed(() => this.requests().length < this.total());

  readonly stats = computed(() => {
    const reqs = this.requests();
    return {
      total: this.total(),
      pending: reqs.filter((r) => r.status === 'pending').length,
      approved: reqs.filter((r) => r.status === 'approved' || r.status === 'available').length,
      declined: reqs.filter((r) => r.status === 'declined').length,
    };
  });

  ngOnInit() {
    this.load();
  }

  async loadMore() {
    this.page++;
    await this.load();
  }

  private async load() {
    this.loading.set(true);
    try {
      const res = await this.requestsApi.list({
        userId: this.state.userId(),
        limit: 25,
        page: this.page,
      });
      this.requests.update((prev) =>
        this.page === 1 ? res.data : [...prev, ...res.data],
      );
      this.total.set(res.total);
    } finally {
      this.loading.set(false);
    }
  }
}
