import { Injectable, InjectionToken, inject, signal, OnDestroy } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { TranslateService } from '@ngx-translate/core';
import { environment } from '../../../environments/environment';
import { CastSettingsService, CastSubtitleStyle } from './cast-settings.service';
import { ToastService } from './toast.service';
import { CAST_SUBTITLE_SIZE_SCALE } from '../utils/subtitle-presets';
import { Subject } from 'rxjs';
import { normalizeLangCode } from '../utils/language.utils';
import type { QoeSample } from './playback-engine';

/** Custom Cast message namespace; keep in sync with `cast-receiver/receiver.js`. */
const FLIKS_CAST_NAMESPACE = 'urn:x-cast:media.fliks.app';

/** Receiver → sender playback-quality push; the sender folds it into its heartbeat. */
interface ReceiverQoe {
  kind: 'qoe';
  at: number;
  /** Session id of the LOAD the sample belongs to; absent on an older receiver. */
  sid?: string;
  sample: QoeSample;
}

/** Receiver to sender error payload; all fields optional for forward-compatibility with older senders. */
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

import type { EdlWire } from '../utils/edl-policy';
declare const cast: any;
declare const chrome: any;

export interface CastMediaInfo {
  url: string;
  contentType: string;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  currentTime?: number;
  /** When false the receiver loads paused; recovery reloads pass the current pause state so a paused cast isn't resumed. */
  autoplay?: boolean;
  subtitles?: { url: string; language: string; label: string }[];
  activeSubtitleTrackId?: number;
  /** IDs forwarded to the Fliks receiver via `customData`; ignored by the Default Media Receiver fallback. */
  mediaId?: number;
  episodeId?: number;
  /** `.edl` ranges on the cast stream's timeline; the receiver applies them. */
  edl?: EdlWire;
  /** Receiver session key: skipped commercials survive reloads of the same file. */
  mediaFileId?: number;
  /** The viewing being cast; the receiver echoes it in its qoe sample. */
  playbackId?: string;
  /** Live-session id of this load; the receiver echoes it in each qoe message. */
  sid?: string;
  /** Translated notice texts the receiver shows when it skips. */
  edlLabels?: { cut: string; commercial: string };
  /** False: the receiver never skips commercials. Absent means true. */
  autoSkipCommercials?: boolean;
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
  autoplay: boolean;
  customData?: Record<string, unknown>;
  /** Mapped to the platform's native text-track style on Android and iOS and attached to MediaInformation. */
  textTrackStyle?: CastSubtitleStyle;
  /** The same styling already in Cast wire form. The desktop bridge talks the
   *  protocol directly and has no platform type to map the presets onto. */
  castTextTrackStyle?: CastTextTrackStyle;
}

/** `TextTrackStyle` as the Cast protocol carries it. */
export interface CastTextTrackStyle {
  fontGenericFamily: string;
  fontScale: number;
  foregroundColor: string;
  backgroundColor: string;
  edgeType: string;
  edgeColor: string;
}

interface NativeCastPlugin {
  /** `connected` + `resume` when a session outlived the WebView or app process; a later resume arrives on `castStateChanged`. */
  initialize(opts: { appId: string }): Promise<{
    available: boolean;
    connected?: boolean;
    resume?: unknown;
  }>;
  /** Persisted per Cast session id, dropped when the session ends. */
  setResumeState?(opts: { state: unknown }): Promise<void>;
  /** iOS: the heartbeat PUT the plugin repeats while the WebView is suspended (locked phone); the receiver's position replaces the body's. */
  setHeartbeat?(opts: { url: string; token: string; body: Record<string, unknown> }): Promise<void>;
  isConnected(): Promise<{ connected: boolean }>;
  requestSession(): Promise<void>;
  /** Native-only device enumeration + selection backing the unified picker
   *  (`shared/remote-picker`): the web Cast SDK has no equivalent. */
  /** `browse`: the picker is showing the list, so Android scans actively for a while. */
  getCastDevices(opts?: { browse?: boolean }): Promise<{ devices: CastDevice[] }>;
  selectCastDevice(opts: { id: string }): Promise<void>;
  loadMedia(opts: NativeCastLoadOpts): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(opts: { time: number }): Promise<void>;
  stop(): Promise<void>;
  disconnect(): Promise<void>;
  setActiveSubtitle(opts: { trackId: number }): Promise<void>;
  setActiveAudioLanguage(opts: { language: string; name: string }): Promise<{ success: boolean }>;
  /** Set the Cast device output level (0..1) / mute. Drives the receiver
   *  volume, not the phone's — the OS volume keys already do the latter. */
  setVolume(opts: { level: number }): Promise<void>;
  setMuted(opts: { muted: boolean }): Promise<void>;
  /** A JSON string on the Fliks namespace to the connected receiver. */
  sendMessage?(opts: { namespace: string; message: string }): Promise<void>;
}

/** One row of native discovery. `connected` marks the device this sender is
 *  casting to, so the picker can offer to leave it. */
export interface CastDevice {
  id: string;
  name: string;
  modelName?: string;
  connected?: boolean;
}

/** Same surface as the Capacitor plugin (see `desktop/src/shared/contract.ts`) plus an event subscription,
 * since contextIsolation keeps preload objects out of the page and events are re-dispatched as window events. */
interface DesktopCastBridge extends NativeCastPlugin {
  on(handler: (event: { name: string; detail: unknown }) => void): () => void;
}

const DesktopCast = (globalThis as { fliksCast?: DesktopCastBridge }).fliksCast;
/** The native Cast plugin (desktop shell bridge, else Capacitor's), injected so a test supplies its own.
 *  Boxed: the plugin proxy answers every property, and an injector calls a value's `ngOnDestroy`. */
export const CAST_BRIDGE = new InjectionToken<{ plugin: NativeCastPlugin }>('CAST_BRIDGE', {
  providedIn: 'root',
  factory: () => ({ plugin: DesktopCast ?? registerPlugin<NativeCastPlugin>('NativeCast') }),
});
const CAST_APP_ID = environment.castAppId;
/** Ceiling on a connect attempt: a cold receiver launch is ~2 s on a Chromecast. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Coalesces a seek burst into a leading plus one trailing dispatch; raw SEEK storms leave the receiver's A/V buffers at different targets. */
const CAST_SEEK_COALESCE_MS = 220;
/** The receiver echoes the old position after a seek; ignore echoes until the target is reached or this window elapses. */
const CAST_SEEK_SETTLE_MS = 2500;
/** How close a receiver time must be to the target to count as "arrived". */
const CAST_SEEK_CONVERGE_TOL = 1.5;
/** A receiver can ignore the LOAD's `activeTrackIds` while it is still publishing its tracks. */
const CAST_TEXT_REAPPLY_MS = 1500;

@Injectable({ providedIn: 'root' })
export class CastService implements OnDestroy {
  /** A receiver is reachable right now, not merely "the SDK loaded": the Cast
   *  entry points are hidden when nothing can be cast to. */
  readonly isAvailable = signal(false);
  readonly isConnected = signal(false);
  /** Set when a session survived a WebView reload or a process restart: the state
   *  the player saved with {@link saveResumeState}. */
  readonly resumedState = signal<unknown>(null);
  /** Web: the LOAD `customData` of the media already on the receiver, e.g. an auto-joined session after a tab reload. */
  readonly rejoinedMedia = signal<Record<string, unknown> | null>(null);
  /** Resolves once a native or desktop bridge has reported a session that outlived the renderer. */
  readonly settled: Promise<void> = Promise.resolve();
  /** Write only via {@link beginConnecting} / {@link endConnecting}: the trigger is disabled while set, so a lost outcome would wedge the picker. */
  readonly connecting = signal(false);
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly isPaused = signal(true);
  /** The receiver reached the natural end of the media (IDLE, reason FINISHED); cleared by the next LOAD. */
  readonly ended = signal(false);
  /** Receiver (Cast device) output level 0..1 and mute flag, mirrored from the
   *  RemotePlayer (web) / native plugin poll. Drives the cast volume slider. */
  readonly volume = signal(1);
  readonly muted = signal(false);
  /** Receiver is loading/buffering (not yet playing) — drives the
   *  indeterminate seekbar sweep in the cast overlay. */
  readonly buffering = signal(false);
  readonly mediaTitle = signal('');
  /** Base pour sous-titres / URLs Cast ; renseignée dans reloadCastStream via cast-info. */
  readonly castStreamBaseUrl = signal('');
  /** Cast devices visible to native discovery. Always empty on web: the
   *  Chrome Cast SDK exposes no enumeration API (see getCastDevices()). */
  readonly castDevices = signal<CastDevice[]>([]);

  // ── Seek coalescing (see CAST_SEEK_* above) ──
  private seekCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSeekTarget: number | null = null;
  private lastDispatchedSeekTarget: number | null = null;
  private seekSettleUntil = 0;

  /** The LOAD in flight: a pick made meanwhile waits for the media session it belongs to. */
  private pendingLoad: Promise<void> | null = null;
  /** The text track the viewer last asked for (0: none); the latest ask wins over any LOAD. */
  private wantedTextTrackId = 0;
  private textReapplyTimer: ReturnType<typeof setTimeout> | null = null;

  /** A receiver failure a fresh stream may fix; `position` is the playhead to resume from. */
  readonly playbackError$ = new Subject<{ position?: number }>();
  /** Every `player_error` the receiver reports, for QoE. */
  readonly receiverError$ = new Subject<{ code?: number; category: string; message?: string }>();

  /** Native Cast sender (Capacitor plugin or Electron main); without one we drive the Cast Web SDK in a browser. */
  private readonly bridge = inject(CAST_BRIDGE).plugin;
  private readonly hasCastBridge = Capacitor.isNativePlatform() || !!DesktopCast;

  /** True when the sender lists devices itself, else the picker offers the single row opening the browser's Cast dialog. */
  readonly enumerates = this.hasCastBridge;
  private readonly castSettings = inject(CastSettingsService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  /** Tracks which session id we already attached the error listener to
   *  so a reconnect to the same session doesn't double-listen. */
  private errorListenerSessionId: string | null = null;
  /** Latest receiver QoE push. */
  readonly receiverQoe = signal<{ sample: QoeSample; receivedAt: number; sid?: string } | null>(null);

  // Web-only
  private webCastReady = false;
  private session: any = null;
  private remotePlayer: any = null;
  private remotePlayerController: any = null;

  constructor() {
    DesktopCast?.on((event) =>
      window.dispatchEvent(new CustomEvent(event.name, { detail: event.detail })),
    );
    if (this.hasCastBridge) {
      this.settled = this.initNative();
    } else {
      this.initWeb();
    }
  }

  /** Appelé dans reloadCastStream juste après cast-info. */
  setCastStreamBase(url: string) {
    this.castStreamBaseUrl.set(url.replace(/\/+$/, ''));
  }

  ngOnDestroy() {
    this.clearSeekCoalescing();
    this.endConnecting();
  }

  // ---- Initialization ----

  /** A stopped or cleared session must not be re-adopted by a reloaded renderer. */
  clearResumeState(): void {
    this.resumedState.set(null);
    if (this.hasCastBridge) void this.bridge.setResumeState?.({ state: null }).catch(() => {});
  }

  saveResumeState(state: unknown): void {
    if (this.hasCastBridge) void this.bridge.setResumeState?.({ state }).catch(() => {});
  }

  saveHeartbeat(opts: { url: string; token: string; body: Record<string, unknown> }): void {
    if (this.hasCastBridge) void this.bridge.setHeartbeat?.(opts).catch(() => {});
  }

  private async initNative() {
    try {
      const { available, connected, resume } = await this.bridge.initialize({ appId: CAST_APP_ID });
      this.isAvailable.set(available || !!connected);
      if (connected) this.isConnected.set(true);
      if (resume) this.resumedState.set(resume);
      if (available) void this.getCastDevices();

      // Listen for native Cast events
      window.addEventListener('castStateChanged', ((e: CustomEvent) => {
        const connected = e.detail?.connected ?? false;
        if (e.detail?.resume) this.resumedState.set(e.detail.resume);
        this.isConnected.set(connected);
        if (connected) this.endConnecting();
        else {
          this.buffering.set(false);
          this.receiverQoe.set(null);
        }
        // `connected` rides the device listing, so the picker's rows are stale
        // the moment a session starts or ends.
        void this.getCastDevices();
      }) as EventListener);

      // Picker dismissed without selecting a device
      window.addEventListener('castPickerDismissed', () => {
        this.endConnecting();
      });

      window.addEventListener('castMediaUpdate', ((e: CustomEvent) => {
        this.mirrorReceiverTime(e.detail?.currentTime ?? 0);
        this.duration.set(e.detail?.duration ?? 0);
        this.isPaused.set(e.detail?.isPaused ?? true);
        this.buffering.set(e.detail?.buffering ?? false);
        this.ended.set(e.detail?.ended ?? false);
        // Volume fields are optional — older native builds omit them; skip
        // the mirror rather than snapping the slider to a default.
        if (e.detail?.volume != null) this.volume.set(e.detail.volume);
        if (e.detail?.muted != null) this.muted.set(e.detail.muted);
      }) as EventListener);

      // Native IDLE/ERROR poll; overlaps with the forwarded `player_error`, deduped downstream.
      window.addEventListener('castError', ((e: CustomEvent) => {
        this.playbackError$.next({ position: e.detail?.position });
      }) as EventListener);

      // Native senders (Android, iOS, desktop) forward the Fliks-namespace messages here.
      window.addEventListener('castReceiverMessage', ((e: CustomEvent) => {
        if (e.detail?.namespace === FLIKS_CAST_NAMESPACE && typeof e.detail.message === 'string') {
          this.handleReceiverMessage(e.detail.message);
        }
      }) as EventListener);

      // Device discovery updates
      window.addEventListener('castAvailabilityChanged', ((e: CustomEvent) => {
        this.isAvailable.set(e.detail?.available ?? false);
      }) as EventListener);

      // No payload: a plain refetch signal, fired alongside
      // castAvailabilityChanged whenever the route list moves.
      window.addEventListener('castDevicesChanged', () => void this.getCastDevices());
    } catch (e) {
      console.warn('CastBridge.initialize failed', e);
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
        this.initWebCast();
      }
    }, 1000);
    setTimeout(() => clearInterval(pollTimer), 15000);
  }

  private initWebCast() {
    if (this.webCastReady) return;
    try {
      const context = cast.framework.CastContext.getInstance();
      context.setOptions({
        receiverApplicationId: CAST_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      context.addEventListener(
        cast.framework.CastContextEventType.CAST_STATE_CHANGED,
        (e: { castState: string }) => this.applyWebCastState(e.castState),
      );
      this.remotePlayer = new cast.framework.RemotePlayer();
      this.remotePlayerController = new cast.framework.RemotePlayerController(this.remotePlayer);

      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
        () => this.onWebConnectionChanged(),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.MEDIA_INFO_CHANGED,
        () => this.syncRejoinedMedia(),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
        () => this.mirrorReceiverTime(this.remotePlayer.currentTime ?? 0),
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
        () => {
          const state = this.remotePlayer.playerState;
          this.buffering.set(state === chrome.cast.media.PlayerState.BUFFERING);
          this.ended.set(
            state === chrome.cast.media.PlayerState.IDLE &&
              this.session?.getMediaSession?.()?.idleReason === chrome.cast.media.IdleReason.FINISHED,
          );
        },
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.VOLUME_LEVEL_CHANGED,
        () => this.volume.set(this.remotePlayer.volumeLevel ?? 1),
      );
      this.remotePlayerController.addEventListener(
        cast.framework.RemotePlayerEventType.IS_MUTED_CHANGED,
        () => this.muted.set(this.remotePlayer.isMuted ?? false),
      );
      this.webCastReady = true;
      this.applyWebCastState(context.getCastState());
    } catch (e) {
      console.warn('Cast framework init failed', e);
      this.isAvailable.set(false);
    }
  }

  /** NO_DEVICES_AVAILABLE is the only state that means "nothing to cast to";
   *  NOT_CONNECTED already implies a receiver was discovered. */
  private applyWebCastState(state: string) {
    this.isAvailable.set(
      state !== cast.framework.CastState.NO_DEVICES_AVAILABLE,
    );
  }

  private onWebConnectionChanged() {
    const connected = this.remotePlayer?.isConnected ?? false;
    this.isConnected.set(connected);
    this.endConnecting();
    if (!connected) this.buffering.set(false);
    this.session = connected
      ? cast.framework.CastContext.getInstance().getCurrentSession()
      : null;
    if (connected && this.remotePlayer) {
      this.volume.set(this.remotePlayer.volumeLevel ?? 1);
      this.muted.set(this.remotePlayer.isMuted ?? false);
    }
    if (this.session) {
      this.attachReceiverMessageListener(this.session);
    } else {
      this.errorListenerSessionId = null;
      this.receiverQoe.set(null);
    }
    this.syncRejoinedMedia();
  }

  private syncRejoinedMedia() {
    const data = this.remotePlayer?.isConnected ? this.remotePlayer.mediaInfo?.customData : null;
    const ours = typeof data?.mediaFileId === 'number' && typeof data?.mediaId === 'number';
    this.rejoinedMedia.set(ours ? data : null);
  }

  /** Guards against re-adding on the same session so a reconnect doesn't stack listeners and double-toast. */
  private attachReceiverMessageListener(session: any) {
    const sessionId = session?.getSessionId?.();
    if (sessionId && sessionId === this.errorListenerSessionId) return;
    try {
      session.addMessageListener(FLIKS_CAST_NAMESPACE, (_ns: string, raw: string) =>
        this.handleReceiverMessage(raw),
      );
      this.errorListenerSessionId = sessionId ?? null;
    } catch (err) {
      console.warn('Cast addMessageListener failed', err);
    }
  }

  /** One receiver message on the Fliks namespace, from the web SDK or a native sender. */
  private handleReceiverMessage(raw: string) {
    try {
      const payload = JSON.parse(raw) as ReceiverPlayerError | ReceiverQoe;
      if (payload?.kind === 'qoe') {
        if (payload.sample) this.receiverQoe.set({ sample: payload.sample, receivedAt: Date.now(), sid: payload.sid });
        return;
      }
      if (payload?.kind !== 'player_error') return;
      const shaka = payload.shakaErrorCode;
      this.receiverError$.next({
        code: shaka ?? payload.detailedErrorCode,
        category: shaka != null ? 'shaka' : 'cast',
        message: payload.reason,
      });
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
  }

  /** Worth a fresh-stream reload: 410, Shaka NETWORK errors (1001-1006) or CAF network codes (300-399); anything else toasts. */
  private isRecoverableReceiverError(p: ReceiverPlayerError): boolean {
    if (p.httpStatus === 410) return true;
    const shaka = p.shakaErrorCode;
    if (shaka != null && shaka >= 1001 && shaka <= 1006) return true;
    const detailed = p.detailedErrorCode;
    if (detailed != null && detailed >= 300 && detailed < 400) return true;
    return false;
  }

  private handleReceiverError(payload: ReceiverPlayerError) {
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

  // ---- Public API ----

  requestSession() {
    this.beginConnecting();
    if (this.hasCastBridge) {
      // The plugin resolves immediately; castStateChanged fires on connect OR dismiss.
      this.bridge.requestSession().catch(() => this.endConnecting());
    } else {
      cast.framework.CastContext.getInstance().requestSession().catch(() => this.endConnecting());
    }
  }

  /** A connect attempt whose outcome is an event, not the call's own return: the
   *  deadline is the last resort for one that never reports either way. */
  private beginConnecting(): void {
    this.connecting.set(true);
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.connectTimeout = setTimeout(() => {
      console.warn('[cast] no session outcome within the connect deadline');
      this.endConnecting();
    }, CONNECT_TIMEOUT_MS);
  }

  private endConnecting(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.connecting.set(false);
  }

  /** Web has no enumeration API, so this resolves empty and the picker falls back to `requestSession()`. */
  async getCastDevices(opts?: { browse?: boolean }): Promise<CastDevice[]> {
    if (!this.hasCastBridge) return [];
    try {
      const { devices } = await this.bridge.getCastDevices(opts);
      this.castDevices.set(devices);
      return devices;
    } catch (err) {
      console.warn('CastBridge.getCastDevices failed', err);
      this.castDevices.set([]);
      return [];
    }
  }

  /** Native only; rejects if the route vanished between listing and selection, which the picker surfaces as a toast. */
  async selectCastDevice(id: string): Promise<void> {
    this.beginConnecting();
    try {
      await this.bridge.selectCastDevice({ id });
    } catch (err) {
      this.endConnecting();
      throw err;
    }
  }

  /** Rejects when the receiver refuses the LOAD. */
  async loadMedia(info: CastMediaInfo) {
    // Drops a pending seek from a prior stream so a trailing dispatch can't hit the new session at a stale target.
    this.clearSeekCoalescing();
    this.cancelTextReapply();
    this.ended.set(false);
    this.wantedTextTrackId = info.activeSubtitleTrackId ?? 0;
    const load = this.sendLoad(info);
    // Waiters on pendingLoad only need it settled; the failure goes to our caller.
    const settled = load.then(() => {}, () => {});
    this.pendingLoad = settled;
    try {
      await load;
    } finally {
      if (this.pendingLoad === settled) this.pendingLoad = null;
    }
  }

  private async sendLoad(info: CastMediaInfo): Promise<void> {
    // Must stay JSON-serialisable and secret-free: `customData` is logged in plain text by the CAF debug overlay.
    const customData = {
      title: info.title,
      subtitle: info.subtitle,
      posterUrl: info.posterUrl,
      mediaId: info.mediaId,
      episodeId: info.episodeId,
      mediaFileId: info.mediaFileId,
      playbackId: info.playbackId,
      sid: info.sid,
      edl: info.edl,
      edlLabels: info.edl ? info.edlLabels : undefined,
      autoSkipCommercials: info.edl ? info.autoSkipCommercials : undefined,
    };

    const subtitleStyle = this.castSettings.get().subtitleStyle;

    if (this.hasCastBridge) {
      await this.bridge.loadMedia({
        url: info.url,
        contentType: info.contentType,
        title: info.title,
        subtitle: info.subtitle ?? '',
        posterUrl: info.posterUrl ?? '',
        currentTime: info.currentTime ?? 0,
        subtitles: info.subtitles ?? [],
        activeSubtitleTrackId: info.activeSubtitleTrackId ?? 0,
        autoplay: info.autoplay ?? true,
        customData,
        textTrackStyle: subtitleStyle,
        castTextTrackStyle: buildCastTextTrackStyle(subtitleStyle),
      });
      this.isPaused.set(false);
      this.mediaTitle.set(info.title);
      return;
    }

    // Web
    if (!this.session) throw new Error('No Cast session');

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
    // Always sent: the receiver applies its own defaults when the style is missing, masking the user's prefs.
    mediaInfo.textTrackStyle = this.buildWebTextTrackStyle(subtitleStyle);

    const request = new chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = info.currentTime ?? 0;
    request.autoplay = info.autoplay ?? true;
    if (info.activeSubtitleTrackId) {
      request.activeTrackIds = [info.activeSubtitleTrackId];
    }

    await this.session.loadMedia(request);
    this.mediaTitle.set(info.title);
    this.isPaused.set(info.autoplay === false);
    if (info.activeSubtitleTrackId) {
      this.textReapplyTimer = setTimeout(() => {
        this.textReapplyTimer = null;
        if (this.wantedTextTrackId > 0) this.applyTextTrack(this.wantedTextTrackId);
      }, CAST_TEXT_REAPPLY_MS);
    }
  }

  play() {
    if (this.hasCastBridge) { this.bridge.play(); this.isPaused.set(false); return; }
    if (!this.remotePlayerController) return;
    this.isPaused.set(false);
    if (this.remotePlayer?.isPaused) this.remotePlayerController.playOrPause();
  }

  pause() {
    if (this.hasCastBridge) { this.bridge.pause(); this.isPaused.set(true); return; }
    if (!this.remotePlayerController) return;
    this.isPaused.set(true);
    if (!this.remotePlayer?.isPaused) this.remotePlayerController.playOrPause();
  }

  togglePlayPause() {
    if (this.hasCastBridge) {
      if (this.isPaused()) this.play(); else this.pause();
      return;
    }
    if (!this.remotePlayerController) return;
    this.isPaused.set(!this.isPaused());
    this.remotePlayerController.playOrPause();
  }

  /** Raising the slider lifts a mute; signals are set optimistically and confirmed by the receiver echo. */
  setVolume(level: number) {
    const v = Math.min(1, Math.max(0, level));
    this.volume.set(v);
    if (v > 0 && this.muted()) this.setMuted(false);
    if (this.hasCastBridge) { this.bridge.setVolume({ level: v }).catch(() => {}); return; }
    if (!this.remotePlayer || !this.remotePlayerController) return;
    this.remotePlayer.volumeLevel = v;
    this.remotePlayerController.setVolumeLevel();
  }

  /** A message on the Fliks namespace to the receiver; dropped when nothing is connected. */
  sendFliks(msg: object): void {
    const message = JSON.stringify(msg);
    if (this.hasCastBridge) {
      void this.bridge.sendMessage?.({ namespace: FLIKS_CAST_NAMESPACE, message }).catch(() => {});
      return;
    }
    try {
      void Promise.resolve(cast.framework.CastContext.getInstance().getCurrentSession?.()?.sendMessage(FLIKS_CAST_NAMESPACE, message)).catch(() => {});
    } catch { /* no session */ }
  }

  setMuted(muted: boolean) {
    this.muted.set(muted);
    if (this.hasCastBridge) { this.bridge.setMuted({ muted }).catch(() => {}); return; }
    if (!this.remotePlayer || !this.remotePlayerController) return;
    // muteOrUnmute() toggles receiver-side, so only fire it when the receiver's
    // current state differs from the target — avoids a double-toggle no-op.
    if ((this.remotePlayer.isMuted ?? false) !== muted) {
      this.remotePlayerController.muteOrUnmute();
    }
  }

  toggleMute() {
    const silent = this.muted() || this.volume() === 0;
    if (!silent) { this.setMuted(true); return; }
    this.setMuted(false);
    if (this.volume() === 0) this.setVolume(1);
  }

  seek(time: number) {
    const dur = this.duration();
    const target = dur > 0 ? Math.max(0, Math.min(time, dur)) : Math.max(0, time);
    // Whether a prior seek is still in flight — captured BEFORE the window is
    // refreshed below (mirrorReceiverTime zeroes it once the receiver arrives).
    const settling = this.seekSettleUntil > Date.now();
    // Pin the target and mark the seek in flight before dispatching, so bursts accumulate and stale echoes can't bounce it back.
    this.pendingSeekTarget = target;
    this.currentTime.set(target);
    this.seekSettleUntil = Date.now() + CAST_SEEK_SETTLE_MS;
    // Leading edge only while idle; later taps fold into one trailing dispatch so the receiver runs a single buffer flush (A/V desync otherwise).
    if (!settling) this.dispatchSeek(target);
    // Trailing edge: (re)arm; once the burst stops, send the final settled target
    // (skipped when it equals the leading dispatch, i.e. a lone seek).
    if (this.seekCoalesceTimer != null) clearTimeout(this.seekCoalesceTimer);
    this.seekCoalesceTimer = setTimeout(() => {
      this.seekCoalesceTimer = null;
      if (
        this.pendingSeekTarget != null &&
        this.pendingSeekTarget !== this.lastDispatchedSeekTarget
      ) {
        this.dispatchSeek(this.pendingSeekTarget);
      }
    }, CAST_SEEK_COALESCE_MS);
  }

  private dispatchSeek(time: number) {
    this.lastDispatchedSeekTarget = time;
    this.seekSettleUntil = Date.now() + CAST_SEEK_SETTLE_MS;
    if (this.hasCastBridge) { this.bridge.seek({ time }); return; }
    if (!this.remotePlayer) return;
    this.remotePlayer.currentTime = time;
    this.remotePlayerController?.seek();
  }

  /** Holds the pinned target while a settling seek still echoes the pre-seek position, until it arrives or the window elapses. */
  private mirrorReceiverTime(t: number) {
    if (this.seekSettleUntil > 0) {
      const target = this.pendingSeekTarget;
      const arrived = target != null && Math.abs(t - target) <= CAST_SEEK_CONVERGE_TOL;
      if (arrived || Date.now() > this.seekSettleUntil) this.seekSettleUntil = 0;
      else return;
    }
    this.currentTime.set(t);
  }

  private clearSeekCoalescing() {
    if (this.seekCoalesceTimer != null) {
      clearTimeout(this.seekCoalesceTimer);
      this.seekCoalesceTimer = null;
    }
    this.pendingSeekTarget = null;
    this.lastDispatchedSeekTarget = null;
    this.seekSettleUntil = 0;
  }

  stop() {
    if (this.hasCastBridge) { this.bridge.stop(); return; }
    this.remotePlayerController?.stop();
  }

  disconnect() {
    if (this.hasCastBridge) { this.bridge.disconnect(); }
    else { cast.framework.CastContext.getInstance().endCurrentSession(true); }
    this.isConnected.set(false);
    this.session = null;
    this.castStreamBaseUrl.set('');
    this.clearSeekCoalescing();
    this.cancelTextReapply();
    this.wantedTextTrackId = 0;
    this.pendingLoad = null;
  }

  /** Make `trackId` (0: none) the active text track. The latest ask wins: it supersedes
   *  the LOAD's own track and any earlier ask still waiting on a LOAD in flight. */
  async setActiveSubtitle(trackId: number): Promise<void> {
    this.wantedTextTrackId = trackId;
    this.cancelTextReapply();
    await this.pendingLoad;
    if (this.wantedTextTrackId === trackId) this.applyTextTrack(trackId);
  }

  private applyTextTrack(trackId: number) {
    if (this.hasCastBridge) {
      void this.bridge.setActiveSubtitle({ trackId }).catch(() => {});
      return;
    }
    this.applyActiveTracks({ textId: trackId > 0 ? trackId : null });
  }

  private cancelTextReapply() {
    if (this.textReapplyTimer != null) clearTimeout(this.textReapplyTimer);
    this.textReapplyTimer = null;
  }

  /** Switches the audio rendition by language + name via the CAF media bus; returns false if no track matches (caller does a full reload). */
  async setActiveAudioLanguage(language: string, name: string): Promise<boolean> {
    await this.pendingLoad;
    if (this.hasCastBridge) {
      try {
        const { success } = await this.bridge.setActiveAudioLanguage({ language, name });
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

    // The NAME in master.m3u8 is unique per rendition and preserved verbatim; the receiver may
    // hand the language back in either code form, so it only stands in when it is unambiguous.
    const want = normalizeLangCode(language);
    const sameLanguage = audioTracks.filter((t) => normalizeLangCode(t.language) === want);
    const target =
      audioTracks.find((t) => t.name === name)
      ?? (sameLanguage.length === 1 ? sameLanguage[0] : undefined);
    if (!target) return false;

    return this.applyActiveTracks({ audioId: target.trackId });
  }

  /** CAF replaces the whole active set, so AUDIO and TEXT ids are sent together: undefined keeps, null disables, number sets. */
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

  /** Native plugins replicate this mapping so the receiver sees identical values regardless of sender. */
  private buildWebTextTrackStyle(s: CastSubtitleStyle) {
    const wire = buildCastTextTrackStyle(s);
    const style = new chrome.cast.media.TextTrackStyle();
    Object.assign(style, wire);
    // The SDK's own enum member rather than its name, in case the two ever
    // diverge; every other field is a plain string or number either way.
    style.edgeType = chrome.cast.media.TextTrackEdgeType[wire.edgeType];
    return style;
  }
}

function buildCastTextTrackStyle(s: CastSubtitleStyle): CastTextTrackStyle {
  const shadow = SUB_SHADOW[s.shadow] ?? SUB_SHADOW['drop'];
  return {
    fontGenericFamily: 'SANS_SERIF',
    fontScale: SUB_SIZE_SCALE[s.size] ?? SUB_SIZE_SCALE['normal'],
    foregroundColor: SUB_FG_COLOR[s.color] ?? SUB_FG_COLOR['white'],
    backgroundColor: SUB_BG_COLOR[s.background] ?? SUB_BG_COLOR['transparent'],
    edgeType: shadow.edge,
    edgeColor: shadow.color,
  };
}

// Smaller than the Native scale (Cast renders larger); colour/edge tables stay local since Cast uses `#RRGGBBAA`.
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
