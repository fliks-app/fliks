/** Unified playback engine interface (ShakaEngine on web, NativeEngine on Android/iOS).
 * Cast bypasses it: CastPlayerService talks to the Chromecast SDK directly. */

import type shaka from 'shaka-player';
import { isUndecodableError } from './playback-error';
import type { TimeRange } from '../../utils/edl-policy';

// ---- Types ----

export interface AudioTrack {
  id: string;
  language: string;
  label: string;
  selected?: boolean;
  /** False when the device cannot decode the track; absent means playable. */
  supported?: boolean;
}

export interface EngineSubtitleTrack {
  id: string;
  label: string;
  url: string;
  language: string;
  burnIn: boolean;
  subtitleDbId?: number;
  forced?: boolean;
}

export type EngineState = 'idle' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

/** The paused flag implied by a transport state, or `undefined` to leave it alone.
 * 'buffering', 'error' and 'idle' (nothing loaded, e.g. after a failed load) are not a pause the user asked for. */
export function pausedFlagForState(state: EngineState): boolean | undefined {
  if (state === 'playing') return false;
  if (state === 'paused') return true;
  return undefined;
}

export interface EngineStats {
  droppedFrames: number;
  streamBandwidth?: number;
  activeVariant?: {
    width?: number;
    height?: number;
    videoBandwidth?: number;
    audioBandwidth?: number;
    videoCodec?: string;
    audioCodec?: string;
  };
}

export type QoeEngineName = 'shaka' | 'exoplayer' | 'avplayer' | 'mpv' | 'avplay' | 'webos' | 'cast';

/** Playback-quality counters, cumulative since the last load(); null = not measurable here.
 *  Contract: plan/playback-qoe.plan.md §1.1. */
export interface EngineQoeSample {
  engine: QoeEngineName;
  cmcd: boolean;
  droppedFrames: number | null;
  decodedFrames: number | null;
  bandwidthBps: number | null;
  bufferAheadS: number | null;
  variantBitrate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  decoderName: string | null;
  hwDecoder: boolean | null;
}

/** Heartbeat `qoe` block: the engine sample plus what player.ts counts itself. */
export interface QoeSample extends EngineQoeSample {
  stallCount: number;
  stallMs: number;
  recoveryReloads: number;
  /** One viewing, stable across sid changes; set by the player. */
  playbackId?: string;
  /** Receiver only: recent closed stall episodes, resent until the sender has seen them. */
  stalls?: QoeStallEpisode[];
}

export interface QoeStallEpisode {
  at: number;
  position: number | null;
  durationMs: number;
  bufferAheadS: number | null;
  bandwidthBps: number | null;
  variantBitrate: number | null;
}

/** Seconds buffered ahead of the playhead, null when it sits outside every range. */
export function bufferAheadOf(video: Pick<HTMLVideoElement, 'buffered' | 'currentTime'>): number | null {
  const { buffered, currentTime } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) return buffered.end(i) - currentTime;
  }
  return null;
}

/** False when the engine measured nothing yet: such a sample is not worth a `qoe` block. */
export function hasQoeData(s: EngineQoeSample): boolean {
  return [
    s.droppedFrames, s.decodedFrames, s.bandwidthBps, s.bufferAheadS, s.variantBitrate,
    s.width, s.height, s.videoCodec, s.decoderName, s.hwDecoder,
  ].some((v) => v != null);
}

/** An HLS rendition as Shaka lists it; the only engine that reports them. */
export type VariantTrack = shaka.extern.Track;

/** What a native player can be asked for: a resolution ceiling rather than a rendition. */
export type VariantSize = Pick<VariantTrack, 'width' | 'height'>;

/** Opaque to the player: what `addTextTrack` returns, handed back to `selectTextTrack` next to the
 *  pick's descriptor ({@link TextTrackPick}). Each engine builds and reads its own. */
export type TextTrackHandle = object;

/** The fields the mpv and ExoPlayer engines read off the handle they gave out. */
export interface TextTrackPick {
  language?: string;
  forced?: boolean;
  index?: number;
  source?: string | null;
  embIndex?: number | null;
  image?: boolean;
}

interface RetryParameters {
  timeout?: number;
  connectionTimeout?: number;
  maxAttempts?: number;
  baseDelay?: number;
}

/** The knobs core turns, in Shaka's own configuration shape; other engines read what applies. */
export interface EngineConfig {
  abr?: {
    enabled?: boolean;
    defaultBandwidthEstimate?: number;
    useNetworkInformation?: boolean;
    switchInterval?: number;
    bandwidthUpgradeTarget?: number;
    bandwidthDowngradeTarget?: number;
    restrictToElementSize?: boolean;
    advanced?: { minTotalBytes?: number; slowHalfLife?: number };
  };
  streaming?: { bufferBehind?: number; retryParameters?: RetryParameters; maxDisabledTime?: number };
  manifest?: { retryParameters?: RetryParameters };
  preferredAudioLanguage?: string;
  /** mpv crop rectangle (`WxH+X+Y`), or null to clear it. */
  videoCrop?: string | null;
}

export type EngineEventMap = {
  stateChanged: { state: EngineState };
  timeUpdate: { position: number; duration: number; buffered: number };
  // `errorKey` is an i18n key for the user-facing message (raw `message` is for the console); the optional diagnostic fields carry full Shaka/media context to the error card.
  error: {
    code: number;
    message: string;
    errorKey?: string;
    source?: 'shaka' | 'media' | 'session' | 'engine';
    category?: number;
    severity?: number;
    data?: unknown[];
    variant?: string;
    /** Native engines: profile codec key of the audio decoder that failed. */
    audioCodec?: string;
  };
  audioTracksChanged: { tracks: AudioTrack[] };
  /** Single source of truth for the UI volume slider; `volume` is the raw 0..1 level, independent of `muted`. */
  volumechange: { volume: number; muted: boolean };
  ended: void;
  /** First video frame presented; distinct from `stateChanged: 'playing'`, which fires on play(). */
  firstFrame: void;
  /** Backend 410 `session_expired`: the player mints a fresh sid and reloads.
   * Native players can't read the response body, so they map any segment error during stable playback to this. */
  sessionExpired: void;
  /** The AirPlay receiver stopped playback it could not play (native iOS).
   *  No item error comes with it, the player just pauses. */
  externalPlaybackFailed: { reason: string };
};

export type EngineEvent = keyof EngineEventMap;

export type EngineEventHandler<E extends EngineEvent> = (
  data: EngineEventMap[E],
) => void;

// ---- Base class (shared event bus) ----

/** Event-bus plumbing for every PlaybackEngine; subclasses call `this.emit(event, data)`, keeping the typed handler map identical. */
export interface SeekRange {
  start: number;
  end: number;
}

export abstract class AbstractPlaybackEngine {
  /** Engines that own a `<video>` override this with its `seekable`; the rest
   *  fall back to the whole of a known duration. */
  get seekRange(): SeekRange {
    const self = this as unknown as { currentTime?: number; duration?: number };
    const end = Number.isFinite(self.duration) && (self.duration ?? 0) > 0
      ? (self.duration as number)
      : (self.currentTime ?? 0);
    return { start: 0, end };
  }

  /** Null until an engine implements it. */
  async getQoeSample(): Promise<EngineQoeSample | null> {
    return null;
  }

  private handlers = new Map<EngineEvent, Set<EngineEventHandler<any>>>();

  /** Whether `firstFrame` was emitted for this load; the recovery heuristic reads it so a pre-frame failure is fatal. */
  protected firstFrameEmitted = false;

  /** One-shot guard for optimistic session-expired recovery (native engines can't read HTTP status).
   * Re-armed only by {@link resetRecoveryGuard}, never per load(), so a failing reload can't loop. */
  protected recoveryAttempted = false;

  on<E extends EngineEvent>(event: E, handler: EngineEventHandler<E>): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  off<E extends EngineEvent>(event: E, handler: EngineEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  protected emit<E extends EngineEvent>(
    event: E,
    data: EngineEventMap[E],
  ): void {
    const set = this.handlers.get(event);
    if (set) for (const h of set) h(data);
  }

  protected clearHandlers(): void {
    this.handlers.clear();
  }

  /** Re-arms the optimistic-recovery one-shot on a user-initiated (re)load and after a recovery sustains playback. */
  resetRecoveryGuard(): void {
    this.recoveryAttempted = false;
  }

  /** Clear the first-frame latch at the start of a load() so the next stream
   *  re-emits `firstFrame`. */
  protected resetFirstFrame(): void {
    this.firstFrameEmitted = false;
  }

  /** Emits `firstFrame` once per load, from whichever signal first proves a frame was presented. */
  protected emitFirstFrameOnce(): void {
    if (this.firstFrameEmitted) return;
    this.firstFrameEmitted = true;
    this.emit('firstFrame', undefined);
  }

  /** Routes a post-first-frame error to one optimistic `sessionExpired`; true when consumed, false when the caller must surface a real error.
   * Undecodable errors are never a session expiry. */
  protected maybeEmitSessionExpired(err?: Parameters<typeof isUndecodableError>[0]): boolean {
    if (err && isUndecodableError(err)) return false;
    if (this.firstFrameEmitted && !this.recoveryAttempted) {
      this.recoveryAttempted = true;
      this.emit('sessionExpired', undefined);
      return true;
    }
    return false;
  }
}

// ---- Interface ----

export interface PlaybackEngine {
  // ── Lifecycle ──
  init(container: HTMLElement): Promise<void>;
  destroy(): Promise<void>;
  load(url: string, startTime?: number, mimeType?: string, headers?: Record<string, string>): Promise<void>;
  /** Present only on engines that can open paused: the next load() does, then reports `firstFrame` for the paused picture. */
  startPaused?: boolean;
  unload(): Promise<void>;
  /** Re-arms the native optimistic-recovery guard; provided by {@link AbstractPlaybackEngine}. */
  resetRecoveryGuard(): void;
  /** Retries the loaded stream in place after a load error; absent or false means reload instead. */
  retry?(): Promise<boolean>;

  // ── Playback ──
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Release / reacquire the decoder while the app is hidden (Home, input switch, standby). */
  suspend?(): void;
  restore?(): void;
  seek(position: number): Promise<void>;

  // ── State (sync getters) ──
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  /** Seconds between `currentTime` updates when the engine reports it in coarse steps. */
  readonly positionStepS?: number;
  readonly buffered: number;
  /** What a seek can land on: on live it is the sliding window, since `duration` is infinite and `buffered` a few seconds. */
  readonly seekRange: SeekRange;
  playbackRate: number;
  volume: number;
  muted: boolean;
  /** False where the platform owns the level (AVPlay, Capacitor players); the UI must hide its slider. */
  readonly supportsVolume: boolean;
  /** False when `timeUpdate.buffered` is not a real read-ahead (it then just echoes the playhead). */
  readonly measuresBuffer?: boolean;
  /** How often `currentTime` refreshes when slower than a frame (native players: 1 s, and only while
   *  playing); a playhead that stays put for less than that is not frozen. */
  readonly positionUpdateMs?: number;
  /** Silences `ranges` (content seconds, sorted, disjoint) without touching the user's mute/volume.
   *  Persists across loads until replaced; [] clears. */
  setMuteRanges(ranges: readonly TimeRange[]): void;

  // ── Audio tracks ──
  getAudioTracks(): AudioTrack[];
  selectAudioTrack(id: string): Promise<void>;

  // ── Subtitles ──
  // Tracks map by (language, forced); `index` is the 0-based manifest-order ordinal among tracks sharing both.
  addTextTrack(
    url: string,
    language: string,
    label: string,
    forced?: boolean,
    index?: number,
  ): Promise<TextTrackHandle>;
  selectTextTrack(track: TextTrackHandle | null): void;
  setTextVisibility(visible: boolean): void;

  // ── Quality and tuning — only the engines with something to tune implement these ──
  /** The renditions an adaptive engine can pin; absent where the platform owns ABR. */
  getVariantTracks?(): VariantTrack[];
  /** Pins a rendition (Shaka) or caps the resolution (native players). */
  selectVariantTrack?(track: VariantTrack | VariantSize, clearBuffer?: boolean): void;
  /** Applies the keys the engine understands and ignores the rest. */
  configure?(config: EngineConfig): void;

  // ── Stats ──
  getStats(): EngineStats;
  getQoeSample(): Promise<EngineQoeSample | null>;

  // ── Events ──
  on<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
  off<E extends EngineEvent>(event: E, handler: (data: EngineEventMap[E]) => void): void;
}
