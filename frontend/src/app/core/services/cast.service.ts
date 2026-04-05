import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';

declare const cast: any;
declare const chrome: any;

export interface CastMediaInfo {
  url: string;
  contentType: string;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  currentTime?: number;
  subtitles?: { url: string; language: string; label: string }[];
  activeSubtitleTrackId?: number;
}

interface NativeCastPlugin {
  initialize(opts: { appId: string }): Promise<{ available: boolean }>;
  isConnected(): Promise<{ connected: boolean }>;
  requestSession(): Promise<void>;
  loadMedia(opts: any): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(opts: { time: number }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
  setActiveSubtitle(opts: { trackId: number }): Promise<void>;
}

const NativeCast = registerPlugin<NativeCastPlugin>('NativeCast');
const CAST_APP_ID = 'CC1AD845';

@Injectable({ providedIn: 'root' })
export class CastService implements OnDestroy {
  readonly isAvailable = signal(false);
  readonly isConnected = signal(false);
  /** True while waiting for the Cast session to establish. */
  readonly connecting = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly isPaused = signal(true);
  readonly mediaTitle = signal('');
  readonly serverLanUrl = signal('');

  private readonly http = inject(HttpClient);
  private readonly isNative = Capacitor.isNativePlatform();

  // Web-only
  private session: any = null;
  private remotePlayer: any = null;
  private remotePlayerController: any = null;

  constructor() {
    firstValueFrom(this.http.get<{ url: string }>('/api/stream/info/server-url'))
      .then(r => this.serverLanUrl.set(r.url))
      .catch(() => {});

    if (this.isNative) {
      this.initNative();
    } else {
      this.initWeb();
    }
  }

  ngOnDestroy() {}

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  private async initNative() {
    try {
      const { available } = await NativeCast.initialize({ appId: CAST_APP_ID });
      this.isAvailable.set(available);

      // Listen for native Cast events
      window.addEventListener('castStateChanged', ((e: CustomEvent) => {
        const connected = e.detail?.connected ?? false;
        this.isConnected.set(connected);
        if (connected) this.connecting.set(false);
      }) as EventListener);

      // Picker dismissed without selecting a device
      window.addEventListener('castPickerDismissed', () => {
        this.connecting.set(false);
      });

      window.addEventListener('castMediaUpdate', ((e: CustomEvent) => {
        this.currentTime.set(e.detail?.currentTime ?? 0);
        this.duration.set(e.detail?.duration ?? 0);
        this.isPaused.set(e.detail?.isPaused ?? true);
      }) as EventListener);
    } catch {
      this.isAvailable.set(false);
    }
  }

  private initWeb() {
    const w = window as any;
    w['__onGCastApiAvailable'] = (isAvailable: boolean) => {
      if (isAvailable) this.initWebCast();
    };
    if (w.cast?.framework) {
      this.initWebCast();
    }
    // Fallback poll
    const pollTimer = setInterval(() => {
      if (w.cast?.framework) {
        clearInterval(pollTimer);
        if (!this.isAvailable()) this.initWebCast();
      }
    }, 1000);
    setTimeout(() => clearInterval(pollTimer), 15000);
  }

  private initWebCast() {
    try {
      cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: CAST_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      this.remotePlayer = new cast.framework.RemotePlayer();
      this.remotePlayerController = new cast.framework.RemotePlayerController(this.remotePlayer);

      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
        () => this.onWebConnectionChanged(),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
        () => this.currentTime.set(this.remotePlayer.currentTime ?? 0),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
        () => this.isPaused.set(this.remotePlayer.isPaused ?? true),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.DURATION_CHANGED,
        () => this.duration.set(this.remotePlayer.duration ?? 0),
      );
      this.isAvailable.set(true);
    } catch {
      this.isAvailable.set(false);
    }
  }

  private onWebConnectionChanged() {
    const connected = this.remotePlayer?.isConnected ?? false;
    this.isConnected.set(connected);
    this.connecting.set(false);
    this.session = connected
      ? cast.framework.CastContext.getInstance().getCurrentSession()
      : null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  requestSession() {
    this.connecting.set(true);
    if (this.isNative) {
      // The plugin resolves immediately; castStateChanged fires on connect OR dismiss.
      NativeCast.requestSession().catch(() => this.connecting.set(false));
    } else {
      cast.framework.CastContext.getInstance().requestSession().catch(() => this.connecting.set(false));
    }
  }

  async loadMedia(info: CastMediaInfo) {
    console.log('[Cast] loadMedia:', info.url, 'contentType:', info.contentType, 'currentTime:', info.currentTime, 'native:', this.isNative);
    if (this.isNative) {
      try {
        await NativeCast.loadMedia({
          url: info.url,
          contentType: info.contentType,
          title: info.title,
          subtitle: info.subtitle ?? '',
          posterUrl: info.posterUrl ?? '',
          currentTime: info.currentTime ?? 0,
          subtitles: info.subtitles ?? [],
          activeSubtitleTrackId: info.activeSubtitleTrackId ?? 0,
        });
        console.log('[Cast] NativeCast.loadMedia succeeded');
      } catch (err) {
        console.error('[Cast] NativeCast.loadMedia failed:', err);
      }
      this.isPaused.set(false);
      this.mediaTitle.set(info.title);
      return;
    }

    // Web
    if (!this.session) return;

    const mediaInfo = new chrome.cast.media.MediaInfo(info.url, info.contentType);
    // HLS: use BUFFERED for VOD playlists, the Default Media Receiver handles it
    mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
    console.log('[Cast] Web loadMedia:', info.url, 'contentType:', info.contentType, 'streamType: BUFFERED');
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = info.title;
    mediaInfo.metadata.subtitle = info.subtitle ?? '';
    if (info.posterUrl) {
      mediaInfo.metadata.images = [new chrome.cast.Image(info.posterUrl)];
    }
    mediaInfo.customData = { title: info.title, subtitle: info.subtitle, posterUrl: info.posterUrl };

    if (info.subtitles?.length) {
      mediaInfo.tracks = info.subtitles.map((sub: any, i: number) => {
        const track = new chrome.cast.media.Track(i + 1, chrome.cast.media.TrackType.TEXT);
        track.trackContentId = sub.url;
        track.trackContentType = 'text/vtt';
        track.subtype = chrome.cast.media.TextTrackType.SUBTITLES;
        track.name = sub.label;
        track.language = sub.language;
        return track;
      });
      mediaInfo.textTrackStyle = new chrome.cast.media.TextTrackStyle();
      mediaInfo.textTrackStyle.fontScale = 0.85;
      mediaInfo.textTrackStyle.fontGenericFamily = chrome.cast.media.TextTrackFontGenericFamily.SANS_SERIF;
      mediaInfo.textTrackStyle.foregroundColor = '#FFFFFFFF';
      mediaInfo.textTrackStyle.backgroundColor = '#00000000';
      mediaInfo.textTrackStyle.edgeType = chrome.cast.media.TextTrackEdgeType.DROP_SHADOW;
      mediaInfo.textTrackStyle.edgeColor = '#000000FF';
    }

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = info.currentTime ?? 0;
    request.autoplay = true;
    if (info.activeSubtitleTrackId) {
      request.activeTrackIds = [info.activeSubtitleTrackId];
    }

    try {
      console.log('[Cast] Web session.loadMedia calling...');
      await this.session.loadMedia(request);
      console.log('[Cast] Web session.loadMedia succeeded');
      this.mediaTitle.set(info.title);
      this.isPaused.set(false);
      if (info.activeSubtitleTrackId) {
        setTimeout(() => this.setActiveSubtitle(info.activeSubtitleTrackId!), 1500);
      }
    } catch (err) {
      console.error('[Cast] Failed to load media:', err);
    }
  }

  play() {
    if (this.isNative) { NativeCast.play(); this.isPaused.set(false); return; }
    if (!this.remotePlayerController) return;
    this.isPaused.set(false);
    if (this.remotePlayer?.isPaused) this.remotePlayerController.playOrPause();
  }

  pause() {
    if (this.isNative) { NativeCast.pause(); this.isPaused.set(true); return; }
    if (!this.remotePlayerController) return;
    this.isPaused.set(true);
    if (!this.remotePlayer?.isPaused) this.remotePlayerController.playOrPause();
  }

  togglePlayPause() {
    if (this.isNative) {
      if (this.isPaused()) this.play(); else this.pause();
      return;
    }
    if (!this.remotePlayerController) return;
    this.isPaused.set(!this.isPaused());
    this.remotePlayerController.playOrPause();
  }

  seek(time: number) {
    if (this.isNative) { NativeCast.seek({ time }); return; }
    if (!this.remotePlayer) return;
    this.remotePlayer.currentTime = time;
    this.remotePlayerController?.seek();
  }

  stop() {
    if (this.isNative) { NativeCast.stop(); return; }
    this.remotePlayerController?.stop();
  }

  disconnect() {
    if (this.isNative) { NativeCast.disconnect(); }
    else { cast.framework.CastContext.getInstance().endCurrentSession(true); }
    this.isConnected.set(false);
    this.session = null;
  }

  setActiveSubtitle(trackId: number) {
    if (this.isNative) {
      NativeCast.setActiveSubtitle({ trackId });
      return;
    }
    if (!this.session) return;
    const media = this.session.getMediaSession();
    if (!media) return;
    const activeIds = trackId > 0 ? [trackId] : [];
    const request = new chrome.cast.media.EditTracksInfoRequest(activeIds);
    media.editTracksInfo(request, () => {}, () => {});
  }
}
