import { Injectable, computed, inject } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { DeviceService } from './device.service';
import { PlaybackSession } from './playback/playback-session';
import { RemotePlaybackTarget } from './remote-playback-target';
import { RemoteService } from './remote.service';
import { deviceIconFor, type DeviceIcon } from '../utils/device-icon';

/** Where the playback sounds: this device, or the Cast / remote device it is sent to or observed on. */
@Injectable({ providedIn: 'root' })
export class PlaybackDevice {
  private readonly session = inject(PlaybackSession);
  private readonly remote = inject(RemoteService);
  private readonly remoteTarget = inject(RemotePlaybackTarget);
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

  /** The output whose volume the card drives: the Cast receiver, or the remote device. */
  private readonly volumeOutput = computed(() =>
    !this.elsewhere() ? null : this.session.kind() === 'cast' ? this.session.output() : this.remoteTarget,
  );

  readonly canSetVolume = computed(() => this.volumeOutput()?.canSetVolume() ?? false);
  readonly volume = computed(() => this.volumeOutput()?.volume() ?? 1);
  /** A remote device that has yet to report its level has no volume to show. */
  readonly volumeKnown = computed(() => {
    const out = this.volumeOutput();
    return out === this.remoteTarget ? this.remoteTarget.volumeKnown() : true;
  });

  setVolume(level: number): void {
    this.volumeOutput()?.setVolume(level);
  }
}
