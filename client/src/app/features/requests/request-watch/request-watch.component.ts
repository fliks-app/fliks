import { Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { LucideBell, LucideBellOff, LucideCheck, LucideEllipsis, LucideUsers } from '@lucide/angular';
import { translatePlural } from '../../../core/pipes/translate-plural.pipe';
import {
  FliksRequestDetail,
  RequestsService,
  TitleRequestState,
} from '../../../core/services/api/requests.service';
import { ToastService } from '../../../core/services/toast.service';
import { DropdownMenuComponent } from '../../../shared/components/dropdown-menu';
import { RequestRequestersComponent } from '../request-requesters/request-requesters.component';

/** Hero actions of a title that already has an active request: follow it, stop following, or (manager) approve it and see who asked. */
@Component({
  selector: 'app-request-watch',
  imports: [
    TranslatePipe,
    DropdownMenuComponent,
    RequestRequestersComponent,
    LucideBell,
    LucideBellOff,
    LucideCheck,
    LucideEllipsis,
    LucideUsers,
  ],
  templateUrl: './request-watch.component.html',
  host: { class: 'contents' },
})
export class RequestWatchComponent {
  private readonly requests = inject(RequestsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  readonly state = input.required<TitleRequestState>();
  readonly canManage = input(false);
  /** The state changed server-side (watch, unwatch, approve): the host refetches it. */
  readonly changed = output<void>();

  protected readonly busy = signal(false);
  protected readonly detail = signal<FliksRequestDetail | null>(null);
  protected readonly manager = computed(() => this.canManage() && this.state().requestId != null);
  protected readonly pending = computed(() => this.detail()?.status === 'pending');

  protected readonly line = computed(() => {
    const n = this.state().requesterCount;
    return n > 0 ? translatePlural(this.translate, 'requests.requested_by_people', n) : '';
  });

  protected async watch() {
    await this.run(
      (id) => this.requests.watch(id),
      () => this.toast.success(this.translate.instant('requests.watch_success')),
    );
  }

  protected async unwatch() {
    await this.run((id) => this.requests.unwatch(id));
  }

  protected async approve() {
    const id = this.state().requestId;
    if (id == null || this.busy()) return;
    this.busy.set(true);
    try {
      await this.requests.approve(id);
      this.changed.emit();
    } catch {
      /* the global interceptor toasts */
    } finally {
      this.busy.set(false);
    }
  }

  private async run(call: (id: number) => Promise<unknown>, onDone?: () => void) {
    const id = this.state().requestId;
    if (id == null || this.busy()) return;
    this.busy.set(true);
    try {
      await call(id);
      onDone?.();
      this.changed.emit();
    } catch {
      this.toast.error(this.translate.instant('requests.watch_error'));
    } finally {
      this.busy.set(false);
    }
  }
}
