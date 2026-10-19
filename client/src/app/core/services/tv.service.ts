import { Injectable, Signal, computed, inject } from '@angular/core';
import { DeviceService, TvPlatform } from './device.service';

/** Compatibility façade over {@link DeviceService} for existing consumers.
 * `tvPlatform` exposes the TV OS (Tizen, webOS) so per-OS glue can branch without leaking OS names into UI code. */
@Injectable({ providedIn: 'root' })
export class TvService {
  private readonly device = inject(DeviceService);
  readonly isTv: Signal<boolean> = this.device.isTv;
  readonly tvPlatform: Signal<TvPlatform> = this.device.tvPlatform;
  readonly isAndroidTv = computed(() => this.tvPlatform() === 'androidtv');
  readonly isTizen = computed(() => this.tvPlatform() === 'tizen');
  readonly isWebOs = computed(() => this.tvPlatform() === 'webos');
}
