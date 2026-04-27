import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService, PendingRequest } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { LucideAngularModule, LucideMonitor, LucideTablet, LucideSmartphone, LucideTv } from '@lucide/angular';

@Component({
  selector: 'app-pending-requests',
  imports: [
    TranslateModule,
    LucideAngularModule,
    LucideMonitor,
    LucideTablet,
    LucideSmartphone,
    LucideTv,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pending-requests.html',
})
export class PendingRequestsComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly requests = signal<PendingRequest[]>([]);
  readonly loading = signal(true);
  readonly error = signal('');
  /** pairingId currently being approved/denied — disables its buttons. */
  readonly busy = signal<string | null>(null);

  ngOnInit(): void {
    void this.refresh();
  }

  async refresh() {
    this.loading.set(true);
    this.error.set('');
    try {
      const list = await this.auth.pairingPending();
      this.requests.set(list);
    } catch {
      this.error.set('pending_requests.load_error');
    } finally {
      this.loading.set(false);
    }
  }

  async approve(req: PendingRequest) {
    this.busy.set(req.pairingId);
    try {
      await this.auth.pairingApprove(req.pairingId);
      this.requests.set(this.requests().filter((r) => r.pairingId !== req.pairingId));
      this.toast.success(this.translate.instant('pending_requests.approved_toast'));
    } catch {
      this.toast.error(this.translate.instant('pending_requests.action_error'));
    } finally {
      this.busy.set(null);
    }
  }

  async deny(req: PendingRequest) {
    this.busy.set(req.pairingId);
    try {
      await this.auth.pairingDeny(req.pairingId);
      this.requests.set(this.requests().filter((r) => r.pairingId !== req.pairingId));
      this.toast.success(this.translate.instant('pending_requests.denied_toast'));
    } catch {
      this.toast.error(this.translate.instant('pending_requests.action_error'));
    } finally {
      this.busy.set(null);
    }
  }

  /** Pick a relevant icon — best-effort match on the device name string. */
  iconFor(name: string): 'tv' | 'tablet' | 'phone' | 'monitor' {
    const n = name.toLowerCase();
    if (/tv|bravia|shield|fire ?tv|google ?tv/.test(n)) return 'tv';
    if (/tab|tablet|ipad/.test(n)) return 'tablet';
    if (/phone|iphone|pixel|galaxy/.test(n)) return 'phone';
    return 'monitor';
  }

  formatRelative(iso: string): string {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.round(diffMs / 60000);
    if (min < 1) return this.translate.instant('server_history.relative.just_now');
    if (min < 60) return this.translate.instant('server_history.relative.minutes', { n: min });
    const hours = Math.round(min / 60);
    if (hours < 24) return this.translate.instant('server_history.relative.hours', { n: hours });
    const days = Math.round(hours / 24);
    return this.translate.instant('server_history.relative.days', { n: days });
  }

  back() {
    void this.router.navigate(['/']);
  }
}
