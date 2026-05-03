import { Injectable, Signal, inject } from '@angular/core';
import { DeviceService } from './device.service';

/**
 * Compatibility façade over {@link DeviceService}.
 *
 * Historically owned the `body.tv` toggling and TV detection. That logic now
 * lives in `DeviceService`, which also distinguishes phone vs tablet. This
 * façade is kept so existing consumers (TvSpatialNavService, CardActions,
 * PlayerControls, …) keep their imports until migrated.
 */
@Injectable({ providedIn: 'root' })
export class TvService {
  private readonly device = inject(DeviceService);
  readonly isTv: Signal<boolean> = this.device.isTv;
}
