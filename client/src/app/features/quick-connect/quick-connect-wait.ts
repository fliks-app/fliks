import {
  Component,
  DestroyRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { AuthService } from '../../core/services/auth.service';
import { SystemInfoService } from '../../core/services/system-info.service';
import { getDeviceName, getOrCreateDeviceId } from '../../core/utils/device-info';

const POLL_INTERVAL_MS = 2000;

type View = 'starting' | 'waiting' | 'denied' | 'expired' | 'error' | 'outdated';

@Component({
  selector: 'app-quick-connect-wait',
  imports: [TranslatePipe],
  templateUrl: './quick-connect-wait.html',
})
export class QuickConnectWaitComponent implements OnInit, OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly systemInfo = inject(SystemInfoService);

  readonly view = signal<View>('starting');
  readonly deviceName = signal(getDeviceName());
  /** Real host OS name+version ("macOS 26", "Ubuntu 24.04"), shown as a second
   *  line under the device name. Empty until resolved / on platforms without it. */
  readonly systemName = signal('');
  readonly secondsLeft = signal(0);
  readonly code = signal('');

  readonly minutesLeft = computed(() => Math.max(0, Math.ceil(this.secondsLeft() / 60)));

  private pairingId: string | null = null;
  private deviceId: string | null = null;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private countdownHandle: ReturnType<typeof setInterval> | null = null;
  private userId = 0;
  private destroyed = false;

  ngOnInit(): void {
    const param = this.route.snapshot.paramMap.get('userId');
    this.userId = param ? Number(param) : 0;
    if (param && !this.userId) {
      void this.router.navigate(['/select-user'], { queryParams: { autoLaunch: 0 } });
      return;
    }
    void this.start();

    this.destroyRef.onDestroy(() => this.stopTimers());
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopTimers();
    this.cancelPending();
  }

  private cancelPending() {
    if (this.pairingId && this.deviceId) {
      void this.auth.pairingCancel(this.pairingId, this.deviceId).catch(() => undefined);
    }
    this.pairingId = null;
  }

  async start() {
    this.view.set('starting');
    try {
      this.deviceId = await getOrCreateDeviceId();
      // Native OS name+version shown as a second line for the approver and admin dashboard; the device name stays the getDeviceName() label.
      await this.systemInfo.ready();
      this.systemName.set(this.systemInfo.systemName());
      // Prefer the real user-assigned device name ("MacBook de Clément") over the
      // UA-derived model fallback when a native source provides it.
      const realName = this.systemInfo.deviceName();
      if (realName) this.deviceName.set(realName);
      if (this.destroyed) return;
      const { pairingId, code, expiresIn } = await this.auth.pairingRequest(
        this.userId || null,
        this.deviceId,
        this.deviceName(),
        this.systemName() || undefined,
      );
      this.pairingId = pairingId;
      this.code.set(`${code.slice(0, 3)} ${code.slice(3)}`);
      // Left the page while the request was in flight.
      if (this.destroyed) return this.cancelPending();
      this.secondsLeft.set(expiresIn);
      this.view.set('waiting');
      this.startCountdown();
      this.poll();
    } catch (err) {
      // A server without userless requests rejects the missing `userId`.
      const outdated =
        !this.userId &&
        err instanceof HttpErrorResponse &&
        err.status === 400 &&
        JSON.stringify(err.error).includes('userId');
      this.view.set(outdated ? 'outdated' : 'error');
    }
  }

  private async poll() {
    if (this.destroyed || !this.pairingId || !this.deviceId) return;
    try {
      const res = await this.auth.pairingStatus(this.pairingId, this.deviceId);
      if (this.destroyed) return;
      if (res.status !== 'pending') this.pairingId = null;
      if (res.status === 'approved' && res.accessToken) {
        this.view.set('starting');
        await this.auth.loginWithToken(
          res.accessToken,
          res.refreshToken,
          res.refreshTokenExpiresAt,
        );
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
        this.pairingId = null;
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
    this.cancelPending();
    void this.start();
  }

  cancel() {
    this.stopTimers();
    void this.router.navigate(['/select-user'], { queryParams: { autoLaunch: 0 } });
  }
}
