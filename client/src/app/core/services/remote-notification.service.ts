import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { RemoteNotification, type RemoteNotificationCommand } from '../plugins/remote-notification.plugin';
import { imageUrlWithSize } from '../pipes/resolve-url.pipe';
import { DeviceService } from './device.service';
import { LikesApiService } from './api/likes-api.service';
import { NotificationLike } from './notification-like';
import { RemotePlaybackTarget, remoteOverlayOpen } from './remote-playback-target';
import { RemoteService } from './remote.service';
import { ServerConfigService } from './server-config.service';
import { AuthService } from './auth.service';
import { SseService } from './sse.service';
import { parseDeviceLabel } from '../utils/format-device-label';

/** Mirrors the remote target this phone drives into a native notification and applies its
 *  controls: a media notification on Android, a Live Activity on iOS. The position is read
 *  untracked: the native side extrapolates it between state changes. Cast keeps the Cast SDK's
 *  notification, which Play Services would otherwise duplicate.
 *
 *  On iOS the WebView is suspended in the background, so the buttons send their command natively
 *  (hence the connection in the payload) and report back with `sent`. */
@Injectable({ providedIn: 'root' })
export class RemoteNotificationService {
  private readonly device = inject(DeviceService);
  private readonly remote = inject(RemoteService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly auth = inject(AuthService);
  private readonly sse = inject(SseService);
  private readonly translate = inject(TranslateService);
  private readonly injector = inject(Injector);
  private readonly like = new NotificationLike(inject(LikesApiService));

  private shown = false;

  init(): void {
    const ios = this.device.isIosNative() && !this.device.isTv();
    if (!this.device.isAndroidNative() && !ios) return;
    window.addEventListener('remoteNotificationCommand', (e) => {
      const { action, value, sent } = (e as CustomEvent<RemoteNotificationCommand>).detail;
      if (sent) this.applySent(action);
      else this.apply(action, value);
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
      const s = this.remote.targetState();
      untracked(() => void this.like.track(s?.mediaId, s?.episodeId));
      const episode = t.episodeTitle();
      const art = s?.fanartUrl || t.fanartUrl();
      void RemoteNotification.update({
        title: episode || t.mediaTitle(),
        artist: episode ? t.mediaTitle() : undefined,
        artworkUrl: art ? this.serverConfig.resolveUrl(imageUrlWithSize(art, 'medium')) : undefined,
        ...(ios ? this.iosFields(s) : {}),
        playing: !t.isPaused(),
        buffering: t.buffering(),
        position: untracked(t.currentTime),
        duration: t.duration(),
        canSetVolume: t.canSetVolume(),
        volume: t.volume(),
        muted: t.muted(),
        hasNext: t.canPlayNext(),
        liked: this.like.liked(),
        // The target reports no queue; a film has nothing to step through.
        seekButtons: !s?.episodeId,
      }).catch(() => {});
    }, { injector: this.injector });
  }

  private iosFields(s: ReturnType<RemoteService['targetState']>) {
    const selected = this.remote.selectedTarget();
    const label = selected ? parseDeviceLabel(selected.userAgent, selected.systemName, selected.deviceName) : null;
    const poster = s?.posterUrl;
    return {
      serverUrl: this.serverConfig.serverUrl(),
      accessToken: this.auth.accessToken ?? undefined,
      targetId: this.remote.selectedTargetId() ?? undefined,
      byTargetId: this.sse.targetId() ?? undefined,
      mediaId: s?.mediaId ?? undefined,
      episodeId: s?.episodeId ?? undefined,
      thumbnailUrl: poster ? this.serverConfig.resolveUrl(imageUrlWithSize(poster, 'thumb')) : undefined,
      deviceName: label
        ? this.translate.instant('remote.notification_on_device', {
            device: this.translate.instant(label.key, label.params),
          })
        : undefined,
      staleLabel: this.translate.instant('remote.notification_stale'),
    };
  }

  /** The command already went out natively: only the local bookkeeping is left. `shown` stays
   *  set after a stop, so the next run of the effect clears the activity and lifts its guard. */
  private applySent(action: RemoteNotificationCommand['action']): void {
    switch (action) {
      case 'stop':
        this.remote.noteStopSent();
        remoteOverlayOpen.set(false);
        break;
      case 'like':
        this.like.noteToggled();
        break;
    }
  }

  private apply(action: RemoteNotificationCommand['action'], value: number): void {
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
      case 'stop':
        // Native has already dropped the notification; clear the state now so
        // no update recreates it before the stop round-trips.
        this.shown = false;
        this.remote.noteStopSent();
        t.stopPlayback();
        break;
      case 'like':
        void this.like.toggle();
        break;
    }
  }
}
