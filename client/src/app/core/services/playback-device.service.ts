import { Injectable, computed, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { DeviceService } from './device.service';
import { PlaybackSession } from './playback/playback-session';
import { RemoteService } from './remote.service';
import { deviceIconFor, type DeviceIcon } from '../utils/device-icon';

/** Where the playback sounds: this device, or the Cast / remote device it is sent to or observed on. */
@Injectable({ providedIn: 'root' })
export class PlaybackDevice {
  private readonly session = inject(PlaybackSession);
  private readonly remote = inject(RemoteService);
  private readonly device = inject(DeviceService);
  private readonly translate = inject(TranslateService);

  readonly elsewhere = computed(() => !this.session.isLocal() || this.session.observing());

  /** Null on this device. */
  readonly name = computed(() =>
    this.elsewhere() ? (this.session.deviceName() ?? this.translate.instant('session.another_device')) : null,
  );

  readonly icon = computed<DeviceIcon>(() => {
    if (!this.elsewhere()) return this.device.isTv() ? 'tv' : this.device.isTouch() ? 'phone' : 'monitor';
    return this.session.kind() === 'cast' ? 'cast' : deviceIconFor(this.remote.observedTarget()?.formFactor);
  });

}
