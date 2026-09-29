import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { RemoteNotification, type RemoteNotificationAction } from '../plugins/remote-notification.plugin';
import { imageUrlWithSize } from '../pipes/resolve-url.pipe';
import { DeviceService } from './device.service';
import { RemotePlaybackTarget } from './remote-playback-target';
import { RemoteService } from './remote.service';
import { ServerConfigService } from './server-config.service';

/** Mirrors the remote target this phone drives into an Android media notification
 *  and applies its controls. The position is read untracked: the native side
 *  extrapolates it between state changes. Cast keeps the Cast SDK's notification,
 *  which Play Services would otherwise duplicate. */
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
      const t = this.target;
      // Each remote report re-syncs the extrapolated position.
      this.remote.targetState();
      if (!this.remote.isRemoting() || !t.hasMedia() || t.isIdle() || t.isStarting()) {
        if (this.shown) void RemoteNotification.clear().catch(() => {});
        this.shown = false;
        return;
      }
      this.shown = true;
      const episode = t.episodeTitle();
      const art = t.fanartUrl();
      void RemoteNotification.update({
        title: episode || t.mediaTitle(),
        artist: episode ? t.mediaTitle() : undefined,
        artworkUrl: art ? this.serverConfig.resolveUrl(imageUrlWithSize(art, 'medium')) : undefined,
        playing: !t.isPaused(),
        buffering: t.buffering(),
        position: untracked(t.currentTime),
        duration: t.duration(),
        canSetVolume: t.canSetVolume(),
        volume: t.volume(),
        muted: t.muted(),
        hasNext: t.canPlayNext(),
      }).catch(() => {});
    }, { injector: this.injector });
  }

  private apply(action: RemoteNotificationAction, value: number): void {
    const t = this.target;
    if (!t.isConnected()) return;
    switch (action) {
      case 'play':
        if (t.isPaused()) t.togglePlayPause();
        break;
      case 'pause':
        if (!t.isPaused()) t.togglePlayPause();
        break;
      case 'seek':
        t.seek(value);
        break;
      case 'volume':
        t.setVolume(value);
        break;
      case 'next':
        t.playNext();
        break;
    }
  }
}
