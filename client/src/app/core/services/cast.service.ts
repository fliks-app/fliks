import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { CastSettingsService, CastSubtitleStyle } from './cast-settings.service';
import { ToastService } from './toast.service';
import { CAST_SUBTITLE_SIZE_SCALE } from '../utils/subtitle-presets';
import { Subject } from 'rxjs';

/** Custom Cast message namespace shared between the Fliks receiver and
 *  every sender. Used today for receiver → sender error forwarding;
 *  reserved for any future bidirectional control message. Keep in sync
 *  with `cast-receiver/receiver.js`. */
const FLIKS_CAST_NAMESPACE = 'urn:x-cast:media.fliks.app';

/** Receiver → sender error payload. Fields mirror what the receiver
 *  pushes via `fliksBus.broadcast`; everything is optional because the
 *  receiver is forward-compatible with older senders. */
interface ReceiverPlayerError {
  kind: 'player_error';
  at?: number;
  detailedErrorCode?: number;
  severity?: number;
  shakaErrorCode?: number;
  /** HTTP status the failed request returned, when the receiver could read
   *  it — `410` is the live-session-expired signal a fresh sid recovers. */
  httpStatus?: number;
  shakaErrorData?: unknown;
  reason?: string;
  mediaTitle?: string;
  mediaSubtitle?: string;
  mediaId?: number;
  episodeId?: number;
}

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
  /**
   * IDs forwarded to the Fliks Cast Receiver via `customData`. Reserved
   * for receiver-side features that need to identify the media without
   * re-parsing the stream URL — queue / next-episode, skip-intro
   * markers, watch-history sync. Optional today; ignored by the
   * Default Media Receiver fallback.
   */
  mediaId?: number;
  episodeId?: number;
}

interface NativeCastLoadOpts {
  url: string;
  contentType: string;
  title: string;
  subtitle: string;
  posterUrl: string;
  currentTime: number;
  subtitles: { url: string; language: string; label: string }[];
  activeSubtitleTrackId: number;
  customData?: Record<string, unknown>;
  /** Optional — when present, native plugin builds the platform's
   *  text-track-style equivalent (TextTrackStyle on Android, GCKMedia-
   *  TextTrackStyle on iOS) and attaches to MediaInformation. */
  textTrackStyle?: CastSubtitleStyle;
}

interface NativeCastPlugin {
  initialize(opts: { appId: string }): Promise<{ available: boolean }>;
  isConnected(): Promise<{ connected: boolean }>;
  requestSession(): Promise<void>;
  loadMedia(opts: NativeCastLoadOpts): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(opts: { time: number }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
  setActiveSubtitle(opts: { trackId: number }): Promise<void>;
  setActiveAudioLanguage(opts: { language: string; name: string }): Promise<{ success: boolean }>;
}

const NativeCast = registerPlugin<NativeCastPlugin>('NativeCast');
const CAST_APP_ID = environment.castAppId;

@Injectable({ providedIn: 'root' })
export class CastService implements OnDestroy {
  readonly isAvailable = signal(false);
  readonly isConnected = signal(false);
  /** True while waiting for the Cast session to establish. */
  readonly connecting = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly isPaused = signal(true);
  /** Receiver is loading/buffering (not yet playing) — drives the
   *  indeterminate seekbar sweep in the cast overlay. */
  readonly buffering = signal(false);
  readonly mediaTitle = signal('');
  /** Base pour sous-titres / URLs Cast ; renseignée dans reloadCastStream via cast-info. */
  readonly castStreamBaseUrl = signal('');

  /** Fires when the receiver hits a fatal playback error that a fresh
   *  stream (new sid) can recover — a live session GC'd mid-cast 410s the
   *  next segment. `position` is the last known playhead to resume from.
   *  Fed by the native plugin's IDLE/ERROR signal and the web receiver's
   *  custom error message; consumed by CastPlayerService to reload. */
  readonly playbackError$ = new Subject<{ position?: number }>();

  private readonly isNative = Capacitor.isNativePlatform();
  private readonly castSettings = inject(CastSettingsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  /** Tracks which session id we already attached the error listener to
   *  so a reconnect to the same session doesn't double-listen. */
  private errorListenerSessionId: string | null = null;

  // Web-only
  private session: any = null;
  private remotePlayer: any = null;
  private remotePlayerController: any = null;

  constructor() {
    if (this.isNative) {
      this.initNative();
    } else {
      this.initWeb();
    }
  }

  /** Appelé dans reloadCastStream juste après cast-info. */
  setCastStreamBase(url: string) {
    this.castStreamBaseUrl.set(url.replace(/\/+$/, ''));
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
        else this.buffering.set(false);
      }) as EventListener);

      // Picker dismissed without selecting a device
      window.addEventListener('castPickerDismissed', () => {
        this.connecting.set(false);
      });

      window.addEventListener('castMediaUpdate', ((e: CustomEvent) => {
        this.currentTime.set(e.detail?.currentTime ?? 0);
        this.duration.set(e.detail?.duration ?? 0);
        this.isPaused.set(e.detail?.isPaused ?? true);
        this.buffering.set(e.detail?.buffering ?? false);
      }) as EventListener);

      // The plugin maps the receiver's IDLE/ERROR state to this event —
      // the native equivalent of the web receiver's custom error message.
      window.addEventListener('castError', ((e: CustomEvent) => {
        this.playbackError$.next({ position: e.detail?.position });
      }) as EventListener);

      // Device discovery updates
      window.addEventListener('castAvailabilityChanged', ((e: CustomEvent) => {
        this.isAvailable.set(e.detail?.available ?? false);
      }) as EventListener);
    } catch (e) {
      console.warn('NativeCast.initialize failed', e);
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
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
        () =>
          this.buffering.set(
            this.remotePlayer.playerState ===
              chrome.cast.media.PlayerState.BUFFERING,
          ),
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
    if (!connected) this.buffering.set(false);
    this.session = connected
      ? cast.framework.CastContext.getInstance().getCurrentSession()
      : null;
    if (this.session) {
      this.attachReceiverMessageListener(this.session);
    } else {
      this.errorListenerSessionId = null;
    }
  }

  /** Wires the receiver-side custom message bus to the sender's toast.
   *  CAF auto-removes the listener when the session is torn down, but we
   *  guard against re-adding on the same session so a reconnect with the
   *  same id doesn't stack listeners and double-toast the same error. */
  private attachReceiverMessageListener(session: any) {
    const sessionId = session?.getSessionId?.();
    if (sessionId && sessionId === this.errorListenerSessionId) return;
    try {
      session.addMessageListener(FLIKS_CAST_NAMESPACE, (_ns: string, raw: string) => {
        try {
          const payload = JSON.parse(raw) as ReceiverPlayerError;
          if (payload?.kind !== 'player_error') return;
          // A session-expiry / network failure is recoverable: re-establish
          // a fresh stream rather than just toasting a dead-end error.
          if (this.isRecoverableReceiverError(payload)) {
            this.playbackError$.next({});
          } else {
            this.handleReceiverError(payload);
          }
        } catch {
          /* malformed messages are ignored — receiver is forward-compatible */
        }
      });
      this.errorListenerSessionId = sessionId ?? null;
    } catch (err) {
      console.warn('Cast addMessageListener failed', err);
    }
  }

  /** Whether a receiver error is worth a fresh-stream reload rather than a
   *  toast: a 410 (live session GC'd), Shaka's NETWORK category (1001-1006,
   *  the 410 surfaces here as BAD_HTTP_STATUS), or CAF's network/HLS-network
   *  detailed codes (300-399). Anything else (decode, unsupported codec) a
   *  reload can't fix, so it falls through to the toast. */
  private isRecoverableReceiverError(p: ReceiverPlayerError): boolean {
    if (p.httpStatus === 410) return true;
    const shaka = p.shakaErrorCode;
    if (shaka != null && shaka >= 1001 && shaka <= 1006) return true;
    const detailed = p.detailedErrorCode;
    if (detailed != null && detailed >= 300 && detailed < 400) return true;
    return false;
  }

  private handleReceiverError(payload: ReceiverPlayerError) {
    // Map the Shaka error code to a translation key when we recognise it
    // so the toast wording is actionable; fall back to a generic message
    // with the raw code for everything else.
    const knownKey = `cast.error.shaka_${payload.shakaErrorCode}`;
    const fallbackKey = 'cast.error.generic';
    const params = {
      title: payload.mediaTitle ?? '',
      code:
        payload.shakaErrorCode != null
          ? String(payload.shakaErrorCode)
          : payload.detailedErrorCode != null
            ? String(payload.detailedErrorCode)
            : '?',
    };
    const translated = this.translate.instant(knownKey, params);
    const message =
      translated === knownKey
        ? this.translate.instant(fallbackKey, params)
        : translated;
    this.toast.error(message);
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
    // Forwarded to the receiver. Fields here MUST stay JSON-serialisable
    // and free of secrets — `customData` is logged in plain text by the
    // CAF debug overlay.
    const customData = {
      title: info.title,
      subtitle: info.subtitle,
      posterUrl: info.posterUrl,
      mediaId: info.mediaId,
      episodeId: info.episodeId,
    };

    const subtitleStyle = this.castSettings.get().subtitleStyle;

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
          customData,
          textTrackStyle: subtitleStyle,
        });
      } catch (err) {
        console.error('NativeCast.loadMedia failed:', err);
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
    mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
    mediaInfo.metadata.title = info.title;
    mediaInfo.metadata.subtitle = info.subtitle ?? '';
    if (info.posterUrl) {
      mediaInfo.metadata.images = [new chrome.cast.Image(info.posterUrl)];
    }
    mediaInfo.customData = customData;

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
    }
    // Always send the style: receiver bakes in its defaults when
    // textTrackStyle is missing, so skipping it here would mask the
    // user's prefs for any LOAD that happened to omit tracks (e.g.
    // movie cast with no preselected sub).
    mediaInfo.textTrackStyle = this.buildWebTextTrackStyle(subtitleStyle);

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = info.currentTime ?? 0;
    request.autoplay = true;
    if (info.activeSubtitleTrackId) {
      request.activeTrackIds = [info.activeSubtitleTrackId];
    }

    try {
      await this.session.loadMedia(request);
      this.mediaTitle.set(info.title);
      this.isPaused.set(false);
      if (info.activeSubtitleTrackId) {
        setTimeout(() => this.setActiveSubtitle(info.activeSubtitleTrackId!), 1500);
      }
    } catch (err) {
      console.error('Cast loadMedia failed:', err);
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
    this.castStreamBaseUrl.set('');
  }

  setActiveSubtitle(trackId: number) {
    if (this.isNative) {
      NativeCast.setActiveSubtitle({ trackId });
      return;
    }
    this.applyActiveTracks({ textId: trackId > 0 ? trackId : null });
  }

  /**
   * Switch the active audio rendition by language + name through the
   * standard CAF media bus. The receiver mirrors Shaka's HLS audio
   * renditions into MediaInformation with type=AUDIO so each becomes a
   * regular CAF Track addressable via EditTracksInfoRequest (web) or
   * RemoteMediaClient.setActiveMediaTracks (native).
   *
   * Returns false when no matching track is found — caller falls back
   * to a full ffmpeg-restart reload in that case.
   */
  async setActiveAudioLanguage(language: string, name: string): Promise<boolean> {
    if (this.isNative) {
      try {
        const { success } = await NativeCast.setActiveAudioLanguage({ language, name });
        return success;
      } catch {
        return false;
      }
    }
    const session = cast.framework.CastContext.getInstance().getCurrentSession?.();
    const media = session?.getMediaSession?.();
    if (!media?.media) return false;

    const audioTracks = ((media.media.tracks ?? []) as any[]).filter(
      (t) => t.type === chrome.cast.media.TrackType.AUDIO,
    );
    if (!audioTracks.length) return false;

    // Match by name first: Shaka rewrites manifest LANGUAGE attributes from
    // ISO 639-2 (eng) to ISO 639-1 (en) before exposing them, so a plain
    // language equality fails on 3-letter sources. The NAME we emit in
    // master.m3u8 (track title or language fallback) is preserved verbatim.
    const target =
      audioTracks.find((t) => t.name === name)
      ?? audioTracks.find((t) => t.language === language);
    if (!target) return false;

    return this.applyActiveTracks({ audioId: target.trackId });
  }

  /**
   * Send an EditTracksInfoRequest with the union of AUDIO + TEXT active IDs.
   * CAF replaces the whole active set in one shot, so we have to send both
   * to keep them alive. Field semantics:
   *   - undefined → keep current active track of that type
   *   - null      → disable that track type
   *   - number    → set as new active track of that type
   */
  private applyActiveTracks(update: {
    audioId?: number | null;
    textId?: number | null;
  }): boolean {
    const session = cast.framework.CastContext.getInstance().getCurrentSession?.();
    const media = session?.getMediaSession?.();
    if (!media?.media) return false;
    const tracks = (media.media.tracks ?? []) as any[];
    const activeIds = (media.activeTrackIds ?? []) as number[];
    const activeOfType = (type: any) =>
      activeIds.find((id) => tracks.some((t) => t.trackId === id && t.type === type));
    const audioId = update.audioId === undefined
      ? activeOfType(chrome.cast.media.TrackType.AUDIO)
      : update.audioId;
    const textId = update.textId === undefined
      ? activeOfType(chrome.cast.media.TrackType.TEXT)
      : update.textId;
    const newActive = [audioId, textId].filter((x): x is number => x != null);
    const request = new chrome.cast.media.EditTracksInfoRequest(newActive);
    media.editTracksInfo(request, () => {}, () => {});
    return true;
  }

  /** Map subtitle presets (size / colour / shadow / background — the same
   *  vocabulary the local player uses) onto the web Cast SDK's
   *  `TextTrackStyle`. Native plugins replicate this mapping for parity
   *  so the receiver sees identical Cast values regardless of sender. */
  private buildWebTextTrackStyle(s: CastSubtitleStyle) {
    const style = new chrome.cast.media.TextTrackStyle();
    style.fontGenericFamily = chrome.cast.media.TextTrackFontGenericFamily.SANS_SERIF;
    style.fontScale = SUB_SIZE_SCALE[s.size] ?? SUB_SIZE_SCALE['normal'];
    style.foregroundColor = SUB_FG_COLOR[s.color] ?? SUB_FG_COLOR['white'];
    style.backgroundColor = SUB_BG_COLOR[s.background] ?? SUB_BG_COLOR['transparent'];
    const shadow = SUB_SHADOW[s.shadow] ?? SUB_SHADOW['drop'];
    style.edgeType = chrome.cast.media.TextTrackEdgeType[shadow.edge];
    style.edgeColor = shadow.color;
    return style;
  }
}

// Cast Web SDK wire format mappings. The size-scale table is
// **intentionally smaller** than the Native one (see
// `utils/subtitle-presets.ts`) — Cast receivers render at a larger
// base size, so the same `'normal'` preset would look oversized at
// 1.0. Colour and edge tables stay local because Cast uses
// `#RRGGBBAA` (alpha last) while the native side uses `#RRGGBB` and
// Android-format `#AARRGGBB`. Centralising those would force a
// runtime byte-shuffle for no readability gain.
const SUB_SIZE_SCALE = CAST_SUBTITLE_SIZE_SCALE;

const SUB_FG_COLOR: Record<string, string> = {
  white: '#FFFFFFFF',
  yellow: '#FFFF00FF',
  green: '#00FF00FF',
  cyan: '#00FFFFFF',
};

const SUB_BG_COLOR: Record<string, string> = {
  transparent: '#00000000',
  semi: '#00000080',
  black: '#000000FF',
};

const SUB_SHADOW: Record<string, { edge: string; color: string }> = {
  none: { edge: 'NONE', color: '#00000000' },
  drop: { edge: 'DROP_SHADOW', color: '#000000FF' },
  outline: { edge: 'OUTLINE', color: '#000000FF' },
  raised: { edge: 'RAISED', color: '#000000FF' },
};
