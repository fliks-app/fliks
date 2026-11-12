import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { RemoteNotification, type RemoteNotificationAction } from '../plugins/remote-notification.plugin';
import { imageUrlWithSize } from '../pipes/resolve-url.pipe';
import { DeviceService } from './device.service';
import { LikesApiService } from './api/likes-api.service';
import { NotificationLike } from './notification-like';
import { mediaSessionText } from './playback/now-playing-metadata.service';
import { PlaybackSession } from './playback/playback-session';
import { RemotePlaybackTarget } from './remote-playback-target';
import { RemoteService } from './remote.service';
import { ServerConfigService } from './server-config.service';

/** Mirrors the remote target this phone observes (selected or the account session's owner) into an Android media notification / the iOS lock screen and applies its controls.
 *  Position is read untracked (native extrapolates it); Cast keeps the Cast SDK's notification, which Play Services would duplicate. */
@Injectable({ providedIn: 'root' })
export class RemoteNotificationService {
  private readonly device = inject(DeviceService);
  private readonly remote = inject(RemoteService);
  private readonly target = inject(RemotePlaybackTarget);
  private readonly session = inject(PlaybackSession);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly injector = inject(Injector);
  private readonly like = new NotificationLike(inject(LikesApiService));

  private shown = false;

  init(): void {
    if (!this.device.isAndroidNative() && !this.device.isIosNative()) return;
    // A reloaded WebView forgets what native still shows.
    void RemoteNotification.clear().catch(() => {});
    const ios = this.device.isIosNative();
    window.addEventListener('remoteNotificationCommand', (e) => {
      const { action, value } = (e as CustomEvent<{ action: RemoteNotificationAction; value: number }>).detail;
      this.apply(action, value);
    });
    if (ios) this.remote.startedHere.subscribe(() => void RemoteNotification.resume().catch(() => {}));
    effect(() => {
      const t = this.target;
      // Each remote report re-syncs the extrapolated position.
      this.remote.targetState();
      // iOS holds the audio session while shown, so only a target this phone selected qualifies.
      const watched = ios ? this.remote.isRemoting() : this.remote.isObserving();
      if (!watched || t.isIdle()) {
        if (this.shown) void RemoteNotification.clear().catch(() => {});
        this.shown = false;
        return;
      }
      // Between two episodes the lock screen stays: clearing it would release the audio session and suspend the app.
      if (t.isStarting()) return;
      const s = this.remote.targetState();
      this.shown = true;
      const meta = this.session.nowPlaying();
      // A track is liked as an item of its album, an episode as itself.
      untracked(() => void this.like.track(s?.mediaId, meta?.kind === 'album' ? s?.itemId : s?.episodeId));
      if (!meta) return;
      const art = meta.fanartUrl ?? meta.posterUrl;
      void RemoteNotification.update({
        ...mediaSessionText(meta),
        artworkUrl: art ? this.serverConfig.resolveUrl(imageUrlWithSize(art, 'medium')) : undefined,
        playing: !t.uiPaused(),
        buffering: t.buffering(),
        position: untracked(t.position),
        sentAt: Date.now(),
        duration: t.duration(),
        canSetVolume: t.canSetVolume(),
        volume: t.volume(),
        muted: t.muted(),
        hasNext: t.canPlayNext(),
        liked: this.like.liked(),
        // A film is seeked by 10 s; an episode or a track steps to the next one.
        seekButtons: meta.kind !== 'album' && !s?.episodeId,
      }).catch(() => {});
    }, { injector: this.injector });
  }

  private apply(action: RemoteNotificationAction, value: number): void {
    const t = this.target;
    if (!t.isObserving()) return;
    switch (action) {
      case 'play':
        if (t.uiPaused()) t.togglePlayPause();
        break;
      case 'pause':
        if (!t.uiPaused()) t.togglePlayPause();
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
      case 'prev':
        // A track goes to the previous one; anything else restarts.
        if (this.session.nowPlaying()?.kind === 'album') t.playPrevious();
        else t.seek(0);
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
