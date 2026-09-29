import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { RemoteNotification, type RemoteNotificationAction } from '../plugins/remote-notification.plugin';
import { imageUrlWithSize } from '../pipes/resolve-url.pipe';
import { DeviceService } from './device.service';
import { RemotePlaybackTarget } from './remote-playback-target';
import { RemoteService } from './remote.service';
import { ServerConfigService } from './server-config.service';

/** Mirrors the remote-controlled device into an Android media notification and
 *  applies its controls. Pushed on each target report, not on every position
 *  tick: the native side extrapolates the position. */
@Injectable({ providedIn: 'root' })
export class RemoteNotificationService {
  private readonly device = inject(DeviceService);
  private readonly remote = inject(RemoteService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly injector = inject(Injector);
  private shown = false;

  init(): void {
    if (!this.device.isAndroidNative()) return;
    window.addEventListener('remoteNotificationCommand', (e) => {
      const { action, value } = (e as CustomEvent<{ action: RemoteNotificationAction; value: number }>).detail;
      this.apply(action, value);
    });
    effect(() => {
      const s = this.remote.targetState();
      const art = this.target.fanartUrl();
      const hasNext = this.target.canPlayNext();
      const buffering = this.target.buffering();
      const canSetVolume = this.target.canSetVolume();
      if (!this.remote.isRemoting() || !s) {
        if (this.shown) void RemoteNotification.clear().catch(() => {});
        this.shown = false;
        return;
      }
      this.shown = true;
      const episode = s.episodeLabel ?? '';
      void RemoteNotification.update({
        title: episode || s.mediaTitle || '',
        artist: episode ? (s.mediaTitle ?? undefined) : undefined,
        artworkUrl: art ? this.serverConfig.resolveUrl(imageUrlWithSize(art, 'medium')) : undefined,
        playing: s.state === 'playing',
        buffering,
        position: untracked(this.remote.interpolatedPosition),
        duration: s.durationSeconds ?? 0,
        canSetVolume,
        volume: s.volume ?? 1,
        muted: s.muted ?? false,
        hasNext,
      }).catch(() => {});
    }, { injector: this.injector });
  }

  private apply(action: RemoteNotificationAction, value: number): void {
    const targetId = this.remote.selectedTargetId();
    if (!targetId) return;
    switch (action) {
      case 'play':
      case 'pause':
        void this.remote.send(targetId, { action });
        break;
      case 'seek':
        this.target.seek(value);
        break;
      case 'volume':
        this.target.setVolume(value);
        break;
      case 'next':
        this.target.playNext();
        break;
    }
  }
}
