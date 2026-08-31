import {
  AbstractPlaybackEngine,
  AudioTrack,
  EngineStats,
  PlaybackEngine,
} from './playback-engine';
import { SubtitleOverlay } from './subtitle-overlay.util';

/** Open HLS a few rungs up so the picture isn't a soft 256×144 while the
 *  native ABR ramps. ~8 Mbps suits a TV display. */
const WEBOS_START_BITRATE = 8_000_000;

/** Collapse a burst of out-of-buffer seeks (repeated remote presses) into a
 *  single reload after the user settles. Rapid `<video>` reloads crash the
 *  webOS media pipeline, so this debounce is load-bearing, not cosmetic. */
const SEEK_DEBOUNCE_MS = 280;

/**
 * LG webOS native backend.
 *
 * webOS renders the HTML5 `<video>` element on its own hardware media
 * pipeline — native HLS, HW decode of HEVC (8/10-bit), AV1 and Dolby
 * (AC3/EAC3) pass-through, plus HDR. It's a normal in-WebView element
 * (no transparent hardware plane like Tizen AVPlay), so we drive the same
 * `<video>` the Shaka path uses.
 *
 * Two webOS-specific behaviours are handled here:
 *
 *  - `mediaOption`: webOS takes a JSON blob on the `<source>` `type`
 *    attribute that the media pipeline consumes. We use `playTime.start`
 *    for a NATIVE resume and `adaptiveStreaming.bps.start` to open at a
 *    high ABR rung (the native ABR otherwise opens at the lowest rung and
 *    ramps slowly). A firmware that rejects the schema falls back to a
 *    plain `src` load so playback still works.
 *
 *  - Reload-on-seek: our backend serves a full VOD playlist but only
 *    transcodes around the current position; seeking far away makes it
 *    return a transient 503 for the target segment while ffmpeg respawns
 *    there. Shaka/ExoPlayer retry the 503; the native `<video>` does NOT —
 *    a `currentTime` seek to an ungenerated segment sticks in `seeking`
 *    forever. So an out-of-buffer seek RELOADS the stream positioned at the
 *    target (same path as resume, which works), while in-buffer seeks stay
 *    instant via native `currentTime`.
 *
 * Stream URLs carry the auth token as a query param, so the element needs
 * no request headers. Subtitles use the shared {@link SubtitleOverlay}
 * because webOS gives no styleable cue API for the renditions we emit.
 */
export class WebOsEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  private video: HTMLVideoElement | null = null;
  private readonly subtitles = new SubtitleOverlay();
  private _duration = 0;
  /** Last URL handed to `load()` — the base for reload-on-seek. */
  private loadedUrl = '';
  private boundListeners: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];
  private frameCbHandle: number | null = null;
  /** Suppress the persistent `error` handler while a (re)load is in flight —
   *  a mediaOption rejection is recovered via the fallback, not surfaced. */
  private loadingPhase = false;

  /** Optimistic position reported while a seek settles, so the seekbar stays
   *  pinned and relative (±10s) steps accumulate even though the real clock
   *  hasn't moved yet (reload-based seeks take a few seconds). */
  private seekIntent: number | null = null;
  /** Latest out-of-buffer seek target awaiting a (debounced) reload. */
  private pendingReloadTarget: number | null = null;
  /** Single-flight guard: only one reload runs at a time (rapid reloads
   *  crash webOS), the latest pending target wins when it finishes. */
  private reloadInFlight = false;
  private seekDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────

  async init(video: HTMLElement): Promise<void> {
    this.video = video as HTMLVideoElement;
    this.video.style.display = '';
    this.wireListeners();
  }

  async destroy(): Promise<void> {
    this.clearSeekDebounce();
    this.seekIntent = null;
    this.pendingReloadTarget = null;
    const v = this.video;
    if (v) {
      for (const [event, fn] of this.boundListeners) v.removeEventListener(event, fn);
      if (this.frameCbHandle != null && 'cancelVideoFrameCallback' in v) {
        (v as any).cancelVideoFrameCallback(this.frameCbHandle);
      }
      try {
        v.pause();
        this.clearSources();
        v.load();
      } catch { /* element may already be detached */ }
    }
    this.boundListeners = [];
    this.frameCbHandle = null;
    this.video = null;
    this.subtitles.destroy();
    this.clearHandlers();
  }

  private wireListeners(): void {
    const v = this.video;
    if (!v) return;
    const add = (event: keyof HTMLMediaElementEventMap, fn: EventListener) => {
      v.addEventListener(event, fn);
      this.boundListeners.push([event, fn]);
    };

    add('loadedmetadata', () => {
      this._duration = isFinite(v.duration) ? v.duration : 0;
    });
    add('durationchange', () => {
      if (isFinite(v.duration) && v.duration > 0) this._duration = v.duration;
    });
    add('playing', () => {
      this.emit('stateChanged', { state: 'playing' });
      this.emitFirstFrameOnce();
    });
    add('play', () => this.emit('stateChanged', { state: 'playing' }));
    add('pause', () => {
      if (!v.ended) this.emit('stateChanged', { state: 'paused' });
    });
    add('waiting', () => this.emit('stateChanged', { state: 'buffering' }));
    // Same as Tizen: a paused seek has no other path to clear `buffering`, and
    // `play()` clears `v.paused` synchronously, so this can't race the intent.
    add('canplay', () => {
      this.emit('stateChanged', { state: v.paused ? 'paused' : 'playing' });
    });
    add('timeupdate', () => {
      // Drop the optimistic seek target once the real clock catches up to it.
      if (this.seekIntent != null && Math.abs(v.currentTime - this.seekIntent) < 1.5) {
        this.seekIntent = null;
      }
      this.subtitles.updateAt(v.currentTime);
      this.emit('timeUpdate', {
        position: this.currentTime, // intent-aware: pins the bar during a seek
        duration: this._duration || v.duration || 0,
        buffered: this.bufferedEnd(),
      });
      if (v.currentTime > 0) this.emitFirstFrameOnce();
    });
    add('ended', () => {
      this.emit('stateChanged', { state: 'ended' });
      this.emit('ended', undefined);
    });
    add('volumechange', () => {
      this.emit('volumechange', { volume: v.volume, muted: v.muted });
    });
    add('error', () => {
      if (this.loadingPhase) return; // recovered via the load() fallback
      const err = v.error;
      // Network / unsupported-source errors mid-playback are the signature
      // of a backend 410 on a segment (LiveSession gone) or any other
      // transient stream loss the recovery flow handles. Optimistically
      // route the first one to `sessionExpired`; the player swaps to a
      // fresh sid via /playback-info. Repeat errors fall through to fatal.
      const networkShaped =
        err?.code === MediaError.MEDIA_ERR_NETWORK ||
        err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
      if (networkShaped && this.maybeEmitSessionExpired()) return;
      this.emit('error', {
        code: err?.code ?? -1,
        message: mediaErrorMessage(err),
        errorKey: mediaErrorKey(err),
      });
      this.emit('stateChanged', { state: 'error' });
    });

    // requestVideoFrameCallback fires once a frame is actually composited —
    // a tighter "first frame" signal than the `playing` DOM event.
    if ('requestVideoFrameCallback' in v) {
      this.frameCbHandle = (v as any).requestVideoFrameCallback(() => {
        this.frameCbHandle = null;
        this.emitFirstFrameOnce();
      });
    }
  }

  // ── Loading ─────────────────────────────────────────────────────────

  async load(url: string, startTime?: number): Promise<void> {
    if (!this.video) throw new Error('WebOsEngine not initialised');
    this.loadedUrl = url;
    this.resetFirstFrame();
    this.clearSeekDebounce();
    this.pendingReloadTarget = null;
    const start = startTime && startTime > 0 ? startTime : 0;
    this.seekIntent = start > 0 ? start : null; // pin the bar at the resume point
    await this.loadInternal(url, start);
  }

  /** Attach + play at `start`, trying mediaOption first, then plain `src`. */
  private async loadInternal(url: string, start: number): Promise<void> {
    this._duration = 0;
    this.loadingPhase = true;
    try {
      try {
        // Preferred path: native resume + start-bitrate via mediaOption.
        await this.attachAndPlay(url, start, true);
      } catch (e) {
        // Only a mediaOption *schema* rejection (firmware refusing the
        // <source type> payload, surfaced as a media error) is worth a plain-src
        // retry — plain src still plays, with resume via a post-load seek. A
        // load timeout means the stream itself is slow; retrying would just burn
        // another 30s (60s total), so surface it instead of falling back.
        if (e instanceof Error && e.name === 'WebOsLoadTimeout') throw e;
        await this.attachAndPlay(url, start, false);
      }
    } finally {
      this.loadingPhase = false;
    }
  }

  private attachAndPlay(
    url: string,
    startTime: number,
    useMediaOption: boolean,
  ): Promise<void> {
    const v = this.video!;
    this.clearSources();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(() => {
          // Tagged so loadInternal can tell a slow-stream timeout (don't retry)
          // from a mediaOption schema rejection (fall back to plain src).
          const e = new Error('webOS <video> load timeout (30s)');
          e.name = 'WebOsLoadTimeout';
          reject(e);
        }),
        30000,
      );
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', onMeta);
        v.removeEventListener('error', onErr);
        fn();
      };
      const onMeta = () => {
        // mediaOption.playTime.start already positioned the stream; only the
        // plain-src fallback needs a manual resume seek.
        if (!useMediaOption && startTime > 0 && isFinite(v.duration)) {
          try { v.currentTime = startTime; } catch { /* applied on retry */ }
        }
        v.play().catch(() => { /* autoplay gate — controls let the user resume */ });
        finish(resolve);
      };
      const onErr = () => finish(() => reject(new Error(mediaErrorMessage(v.error))));
      v.addEventListener('loadedmetadata', onMeta);
      v.addEventListener('error', onErr);

      if (useMediaOption) {
        const source = document.createElement('source');
        source.src = url;
        source.setAttribute('type', webOsSourceType(url, startTime));
        v.appendChild(source);
      } else {
        v.src = url;
      }
      v.load();
    });
  }

  private clearSources(): void {
    const v = this.video;
    if (!v) return;
    while (v.firstChild) v.removeChild(v.firstChild);
    v.removeAttribute('src');
  }

  async unload(): Promise<void> {
    this.clearSeekDebounce();
    this.seekIntent = null;
    this.pendingReloadTarget = null;
    const v = this.video;
    if (!v) return;
    try {
      v.pause();
      this.clearSources();
      v.load();
    } catch { /* ok */ }
  }

  // ── Playback ────────────────────────────────────────────────────────

  async play(): Promise<void> {
    try { await this.video?.play(); } catch { /* user gesture may be required */ }
  }
  async pause(): Promise<void> {
    this.video?.pause();
  }

  async seek(position: number): Promise<void> {
    const v = this.video;
    if (!v || !isFinite(position)) return;
    const target = Math.max(0, position);
    // Report the target immediately so the bar pins and a follow-up relative
    // step (±10s) is computed from here, not the stale clock.
    this.seekIntent = target;

    // Forward in-buffer: native seek is instant and the UA coalesces rapid
    // ones. Backward seeks are NOT done natively even when "in buffer" — on
    // webOS a backward native seek into an on-demand transcode sticks in
    // `seeking` forever (the pipeline re-requests the behind-playhead segment,
    // gets a 503, and never retries). See #279 for the proper backend fix
    // (long-poll segments) that will let us drop the reload path entirely.
    const backward = target < v.currentTime - 0.5;
    if (!backward && this.isBuffered(target)) {
      this.pendingReloadTarget = null;
      this.clearSeekDebounce();
      try { v.currentTime = target; } catch { /* out of range — ignore */ }
      return;
    }

    // Backward, or forward out-of-buffer: a native seek would request an
    // un-transcoded segment, get a 503, and stick in `seeking` forever.
    // Reload positioned at the target (the resume path, which works) — but
    // DEBOUNCED + single-flight: a burst of small backward steps must
    // collapse to one reload, because rapid `<video>` reloads crash the
    // webOS pipeline.
    this.pendingReloadTarget = target;
    this.clearSeekDebounce();
    this.seekDebounceTimer = setTimeout(() => {
      this.seekDebounceTimer = null;
      this.runReloadIfIdle();
    }, SEEK_DEBOUNCE_MS);
  }

  private runReloadIfIdle(): void {
    // An in-flight reload will pick up `pendingReloadTarget` when it finishes.
    if (this.reloadInFlight) return;
    const target = this.pendingReloadTarget;
    if (target == null) return;
    this.pendingReloadTarget = null;
    this.reloadInFlight = true;
    this.loadInternal(setStartAt(this.loadedUrl, target), target)
      .catch(() => {
        // loadInternal does not emit during its loading phase, so a failed
        // reload-seek would leave seekIntent pinning the seekbar at the
        // unreachable target forever — clear it so the bar tracks the real clock.
        this.seekIntent = null;
      })
      .finally(() => {
        this.reloadInFlight = false;
        // A newer target arrived mid-reload — honour the latest, once.
        if (this.pendingReloadTarget != null) this.runReloadIfIdle();
      });
  }

  private clearSeekDebounce(): void {
    if (this.seekDebounceTimer != null) {
      clearTimeout(this.seekDebounceTimer);
      this.seekDebounceTimer = null;
    }
  }

  /** Whether `pos` sits inside a buffered range with enough margin to play
   *  from (epsilon at the start, ≥0.5s ahead) — so a native seek serves it
   *  instantly instead of triggering a reload. */
  private isBuffered(pos: number): boolean {
    const v = this.video;
    if (!v) return false;
    for (let i = 0; i < v.buffered.length; i++) {
      if (pos >= v.buffered.start(i) - 0.1 && pos <= v.buffered.end(i) - 0.5) return true;
    }
    return false;
  }

  // ── State getters ───────────────────────────────────────────────────

  get currentTime(): number {
    if (this.seekIntent != null) return this.seekIntent;
    return this.video?.currentTime ?? 0;
  }
  get duration(): number { return this._duration || this.video?.duration || 0; }
  get paused(): boolean { return this.video?.paused ?? true; }
  get buffered(): number { return this.bufferedEnd(); }
  get playbackRate(): number { return this.video?.playbackRate ?? 1; }
  set playbackRate(rate: number) { if (this.video) this.video.playbackRate = rate; }
  get volume(): number { return this.video?.volume ?? 1; }
  set volume(v: number) { if (this.video) this.video.volume = v; }
  get muted(): boolean { return this.video?.muted ?? false; }
  set muted(m: boolean) { if (this.video) this.video.muted = m; }

  private bufferedEnd(): number {
    const v = this.video;
    if (!v || v.buffered.length === 0) return 0;
    try { return v.buffered.end(v.buffered.length - 1); } catch { return 0; }
  }

  // ── Audio tracks (native AudioTrackList) ────────────────────────────

  getAudioTracks(): AudioTrack[] {
    const list = this.audioTrackList();
    if (!list) return [];
    const tracks: AudioTrack[] = [];
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      tracks.push({
        id: 'audio-' + (t.id || i),
        language: t.language || 'und',
        label: t.label || t.language || 'Track ' + (i + 1),
      });
    }
    return tracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    const list = this.audioTrackList();
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      t.enabled = 'audio-' + (t.id || i) === id;
    }
  }

  private audioTrackList(): (AudioTrack & { enabled: boolean; id: string })[] | null {
    const v = this.video as unknown as { audioTracks?: any };
    const list = v?.audioTracks;
    return list && typeof list.length === 'number' && list.length > 0 ? list : null;
  }

  // ── Subtitles (shared DOM overlay) ──────────────────────────────────

  async addTextTrack(url: string, language: string, label: string): Promise<unknown> {
    return { url, language, label };
  }
  selectTextTrack(track: unknown): void {
    if (!track || typeof track !== 'object') {
      this.subtitles.clear();
      return;
    }
    const url = (track as { url?: string }).url;
    if (url) void this.subtitles.show(url);
  }
  setTextVisibility(visible: boolean): void {
    this.subtitles.setVisible(visible);
  }
  setSubtitleStyle(style: {
    size?: string;
    color?: string;
    shadow?: string;
    background?: string;
    bottomMargin?: number;
  }): void {
    this.subtitles.setStyle(style);
  }

  // ── Quality — native ABR ────────────────────────────────────────────

  getVariantTracks(): unknown[] { return []; }
  selectVariantTrack(_track: unknown, _clearBuffer?: boolean): void { /* native ABR; pinned via reload */ }
  configure(_config: unknown): void { /* Shaka-specific */ }

  // ── Stats ───────────────────────────────────────────────────────────

  getStats(): EngineStats {
    const v = this.video;
    const q = v && 'getVideoPlaybackQuality' in v ? v.getVideoPlaybackQuality() : null;
    return {
      droppedFrames: q?.droppedVideoFrames ?? 0,
      activeVariant: v
        ? { width: v.videoWidth || undefined, height: v.videoHeight || undefined }
        : undefined,
    };
  }
}

/** Replace (or append) the `startAt` query param so the backend pre-spawns
 *  ffmpeg at the seek target — paired with mediaOption `playTime.start`. */
function setStartAt(url: string, position: number): string {
  const p = Math.max(0, Math.floor(position));
  if (/[?&]startAt=/.test(url)) return url.replace(/([?&]startAt=)[^&]*/, `$1${p}`);
  return url + (url.includes('?') ? '&' : '?') + 'startAt=' + p;
}

/**
 * Build the `<source>` `type` with webOS's `mediaOption` JSON. `playTime.start`
 * resumes natively (ms); `adaptiveStreaming.bps.start` opens HLS at a high rung.
 * Unknown keys are ignored by the pipeline, so this is safe to send always.
 */
function webOsSourceType(url: string, startTime: number): string {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const option: Record<string, unknown> = {};
  if (startTime > 0) {
    option['transmission'] = { playTime: { start: Math.round(startTime * 1000) } };
  }
  if (isHls) {
    option['adaptiveStreaming'] = { bps: { start: WEBOS_START_BITRATE }, seamlessPlay: true };
  }
  const mediaOption = { mediaTransportType: isHls ? 'HLS' : 'URI', option };
  const mime = isHls ? 'application/vnd.apple.mpegurl' : 'video/mp4';
  return `${mime};mediaOption=${encodeURI(JSON.stringify(mediaOption))}`;
}

function mediaErrorMessage(err: MediaError | null): string {
  if (!err) return 'webOS playback error';
  const names: Record<number, string> = {
    1: 'MEDIA_ERR_ABORTED',
    2: 'MEDIA_ERR_NETWORK',
    3: 'MEDIA_ERR_DECODE',
    4: 'MEDIA_ERR_SRC_NOT_SUPPORTED',
  };
  return err.message || names[err.code] || 'webOS playback error (' + err.code + ')';
}

/** Map a numeric MediaError code to a translated i18n key for the overlay. */
function mediaErrorKey(err: MediaError | null): string {
  const keys: Record<number, string> = {
    1: 'player.error_aborted',
    2: 'player.error_network',
    3: 'player.error_decode',
    4: 'player.error_unsupported',
  };
  return (err && keys[err.code]) || 'player.playback_error';
}
