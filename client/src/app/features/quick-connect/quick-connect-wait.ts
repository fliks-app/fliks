import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { getDeviceName, getOrCreateDeviceId } from '../../core/utils/device-info';

const POLL_INTERVAL_MS = 2000;

type View = 'starting' | 'waiting' | 'denied' | 'expired' | 'error';

@Component({
  selector: 'app-quick-connect-wait',
  imports: [TranslateModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './quick-connect-wait.html',
})
export class QuickConnectWaitComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly view = signal<View>('starting');
  readonly deviceName = signal(getDeviceName());
  readonly secondsLeft = signal(0);

  readonly minutesLeft = computed(() => Math.max(0, Math.ceil(this.secondsLeft() / 60)));

  private pairingId: string | null = null;
  private deviceId: string | null = null;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private countdownHandle: ReturnType<typeof setInterval> | null = null;
  private userId = 0;

  ngOnInit(): void {
    const param = this.route.snapshot.paramMap.get('userId');
    this.userId = param ? Number(param) : 0;
    if (!this.userId) {
      void this.router.navigate(['/select-user']);
      return;
    }
    void this.start();

    this.destroyRef.onDestroy(() => this.stopTimers());
  }

  ngOnDestroy(): void {
    this.stopTimers();
  }

  async start() {
    this.view.set('starting');
    try {
      this.deviceId = await getOrCreateDeviceId();
      const { pairingId, expiresIn } = await this.auth.pairingRequest(
        this.userId,
        this.deviceId,
        this.deviceName(),
      );
      this.pairingId = pairingId;
      this.secondsLeft.set(expiresIn);
      this.view.set('waiting');
      this.startCountdown();
      this.poll();
    } catch {
      this.view.set('error');
    }
  }

  private async poll() {
    if (!this.pairingId || !this.deviceId) return;
    try {
      const res = await this.auth.pairingStatus(this.pairingId, this.deviceId);
      if (res.status === 'approved' && res.accessToken) {
        await this.auth.loginWithToken(res.accessToken);
        await this.router.navigate(['/'], { replaceUrl: true });
        return;
      }
      if (res.status === 'denied') {
        this.view.set('denied');
        this.stopTimers();
        return;
      }
      if (res.status === 'expired') {
        this.view.set('expired');
        this.stopTimers();
        return;
      }
    } catch {
      // Network blip — keep polling, server is the source of truth.
    }
    this.pollHandle = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  private startCountdown() {
    this.countdownHandle = setInterval(() => {
      const next = this.secondsLeft() - 1;
      if (next <= 0) {
        this.secondsLeft.set(0);
        this.view.set('expired');
        this.stopTimers();
      } else {
        this.secondsLeft.set(next);
      }
    }, 1000);
  }

  private stopTimers() {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.countdownHandle) {
      clearInterval(this.countdownHandle);
      this.countdownHandle = null;
    }
  }

  retry() {
    this.stopTimers();
    void this.start();
  }

  cancel() {
    this.stopTimers();
    void this.router.navigate(['/select-user']);
  }
}
