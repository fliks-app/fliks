import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AuthService } from '../../../core/services/auth.service';
import { CastSettingsService } from '../../../core/services/cast-settings.service';
import {
  RemoteGrant,
  RemoteGrantsApiService,
} from '../../../core/services/api/remote-grants-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { ToggleFieldComponent } from '../../../shared/components/forms/toggle-field/toggle-field';
import { TvService } from '../../../core/services/tv.service';
import { getDeviceName, getOrCreateDeviceId } from '../../../core/utils/device-info';
import { formatTime } from '../../../core/utils/player.utils';

/**
 * Which accounts may control this device, and which devices this account may
 * control. Consent is a code read off the granting device's screen: standing in
 * front of it is the proof, so no social relationship is involved.
 */
@Component({
  selector: 'app-remote-settings',
  imports: [DatePipe, FormsModule, TranslateModule, ToggleFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './remote-settings.html',
})
export class RemoteSettingsPageComponent implements OnInit, OnDestroy {
  private readonly grantsApi = inject(RemoteGrantsApiService);
  private readonly castSettings = inject(CastSettingsService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  /** A television is a screen someone drives, never the thing driving: the
   *  controller half is hidden there, as the device picker already is. */
  protected readonly isTv = inject(TvService).isTv;

  readonly issuedGrants = signal<RemoteGrant[]>([]);
  readonly heldGrants = signal<RemoteGrant[]>([]);
  /** The code currently on screen, for someone else to read. */
  readonly offeredCode = signal<string | null>(null);
  /** Counts down while a code is displayed; a stale code on a screen is worse
   *  than none, so it says when it stops working. */
  readonly secondsLeft = signal(0);
  readonly formatTime = formatTime;
  private offeredId: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  readonly claimCode = signal('');
  readonly busy = signal(false);
  readonly showHouseholdTargets = signal(true);

  /** Nothing to hide until a device has granted this account, or the account is
   *  an admin and therefore sees every device. */
  readonly canControlOthers = computed(
    () => !!this.auth.user()?.isAdmin || this.heldGrants().length > 0,
  );

  private deviceId = '';

  ngOnInit(): void {
    this.showHouseholdTargets.set(this.castSettings.get().showHouseholdTargets);
    void this.loadGrants();
  }

  onShowHouseholdChange(value: boolean): void {
    this.showHouseholdTargets.set(value);
    // Patch rather than rebuild: this page owns one field of a store the
    // Chromecast page owns the rest of.
    this.castSettings.save({ ...this.castSettings.get(), showHouseholdTargets: value });
  }

  private async loadGrants(): Promise<void> {
    try {
      this.deviceId ||= await getOrCreateDeviceId();
      const { issued, held } = await this.grantsApi.list(this.deviceId);
      this.issuedGrants.set(issued);
      this.heldGrants.set(held);
    } catch (err) {
      // The interceptor surfaces the error; the lists stay as they were rather
      // than reading as "nothing is granted".
      console.warn('[remote-settings] failed to load control grants', err);
    }
  }

  /** Offer this device: the code goes on this screen for someone to read. */
  async offerControl(): Promise<void> {
    this.busy.set(true);
    try {
      this.deviceId ||= await getOrCreateDeviceId();
      const { id, code, expiresIn } = await this.grantsApi.createCode(
        this.deviceId,
        getDeviceName(),
      );
      this.offeredId = id;
      this.offeredCode.set(code);
      this.startCountdown(expiresIn);
    } finally {
      this.busy.set(false);
    }
  }

  /** Withdraw a code still on screen: the row is unclaimed, so the same revoke
   *  path applies. */
  async cancelCode(): Promise<void> {
    const id = this.offeredId;
    this.clearOffer();
    if (id === null) return;
    try {
      await this.grantsApi.revoke(id);
    } catch (err) {
      // Already claimed or already gone: the screen is right either way.
      console.warn('[remote-settings] could not withdraw the code', err);
    }
  }

  private startCountdown(seconds: number): void {
    this.stopTicker();
    this.secondsLeft.set(seconds);
    this.ticker = setInterval(() => {
      const left = this.secondsLeft() - 1;
      this.secondsLeft.set(Math.max(0, left));
      if (left <= 0) this.stopTicker();
    }, 1000);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private clearOffer(): void {
    this.stopTicker();
    this.offeredId = null;
    this.offeredCode.set(null);
    this.secondsLeft.set(0);
  }

  ngOnDestroy(): void {
    this.stopTicker();
  }

  async submitClaim(): Promise<void> {
    const code = this.claimCode().trim();
    if (!code) return;
    this.busy.set(true);
    try {
      const grant = await this.grantsApi.claim(code);
      this.claimCode.set('');
      this.heldGrants.update((list) => [...list, grant]);
      this.toast.success(
        this.translate.instant('remote.grant_claimed', { name: grant.deviceName }),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(grant: RemoteGrant): Promise<void> {
    await this.grantsApi.revoke(grant.id);
    this.issuedGrants.update((l) => l.filter((g) => g.id !== grant.id));
    this.heldGrants.update((l) => l.filter((g) => g.id !== grant.id));
  }
}
