import { Injectable, Signal, computed, inject } from '@angular/core';
import { DeviceService, TvPlatform } from './device.service';

/**
 * Compatibility façade over {@link DeviceService}.
 *
 * Historically owned the `body.tv` toggling and TV detection. That logic now
 * lives in `DeviceService`, which also distinguishes phone vs tablet. This
 * façade is kept so existing consumers (TvSpatialNavService, CardActions,
 * PlayerControls, …) keep their imports until migrated.
 *
 * `tvPlatform` exposes which TV OS is underneath (when any) so per-OS glue
 * (Tizen `tvinputdevice`, webOS `platformBack`) can branch without leaking
 * an OS name into UI code that only cares about the 10-foot form factor.
 */
@Injectable({ providedIn: 'root' })
export class TvService {
  private readonly device = inject(DeviceService);
  readonly isTv: Signal<boolean> = this.device.isTv;
  readonly tvPlatform: Signal<TvPlatform> = this.device.tvPlatform;
  readonly isAndroidTv = computed(() => this.tvPlatform() === 'androidtv');
  readonly isTizen = computed(() => this.tvPlatform() === 'tizen');
  readonly isWebOs = computed(() => this.tvPlatform() === 'webos');
}
