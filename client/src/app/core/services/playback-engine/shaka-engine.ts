import shaka from 'shaka-player';
import {
  AbstractPlaybackEngine,
  AudioTrack,
  bufferAheadOf,
  EngineQoeSample,
  EngineStats,
  PlaybackEngine,
  EngineState,
  EngineConfig,
  SeekRange,
  TextTrackHandle,
  VariantTrack,
} from './playback-engine';
import { normalizeLangCode } from '../../utils/language.utils';
import type { TimeRange } from '../../utils/edl-policy';
import { MuteGate } from './mute-gate';

const MAX_NETWORK_RETRIES = 10;
const NETWORK_RETRY_DELAY_S = 2;

/** A 4xx won't heal on retry; Shaka's BAD_HTTP_STATUS carries the status in data[1]. */
function isClientHttpError(e: shaka.util.Error): boolean {
  const status = e.code === 1001 ? Number(e.data?.[1]) : 0;
  return status >= 400 && status < 500;
}

/** Shaka implementation of PlaybackEngine; plain TypeScript with no Angular dependencies. */
export class ShakaEngine extends AbstractPlaybackEngine implements PlaybackEngine {

  private player: shaka.Player | null = null;
  private video: HTMLVideoElement | null = null;

  /** Refs kept so we can removeEventListener on destroy. */
  private videoListeners: Array<{ event: string; handler: EventListener }> = [];
  private shakaListeners: Array<{ event: string; handler: EventListener }> = [];

  /** Set after the 410 filter emits `sessionExpired`; suppresses the bridged `error` for one tick so no fatal overlay shows during recovery. */
  private sessionExpiredInFlight = false;

  /** Consecutive streaming retries since the last appended segment. */
  private networkRetries = 0;

  /** The user's own mute; `video.muted` is this OR the EDL gate. */
  private userMuted = false;
  private gated = false;
  private lastVolumeEvent: { volume: number; muted: boolean } | null = null;
  private muteGate: MuteGate | null = null;
  private muteRanges: readonly TimeRange[] = [];

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async init(container: HTMLElement): Promise<void> {
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      throw new Error('Shaka Player: browser not supported');
    }

    const video = container as HTMLVideoElement;
    this.video = video;
    this.userMuted = video.muted;
    this.muteGate = new MuteGate({
      position: () => video.currentTime,
      rate: () => video.playbackRate,
      paused: () => video.paused,
      apply: (gated) => {
        this.gated = gated;
        video.muted = this.userMuted || gated;
      },
    });
    this.muteGate.setRanges(this.muteRanges);

    this.player = new shaka.Player();

    // UITextDisplayer renders each cue line as a DOM node, so font-size/line-height/spacing are overridable CSS, unlike native VTTCue rendering.
    if (video.parentElement) {
      this.player.setVideoContainer(video.parentElement);
      this.player.configure({
        textDisplayFactory: (player: shaka.Player) =>
          new shaka.text.UITextDisplayer(player),
      });
    }

    await this.player.attach(video);

    // Sensible streaming defaults
    this.player.configure({
      streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 1,
        bufferBehind: 60,
        // A selected subtitle track whose segments 404 or fail to parse is
        // dropped instead of aborting video and audio playback.
        ignoreTextStreamFailures: true,
      },
      // The app's selection is the only authority on subtitles: Shaka would
      // otherwise show a forced track in the audio language on every load.
      accessibility: { handleForcedSubtitlesAutomatically: false },
      cmcd: { enabled: true, useHeaders: false },
    });

    this.installSessionExpiredFilter();
    this.bridgeVideoEvents();
    this.bridgeShakaEvents();
  }

  /** Turns the backend's 410 "session_expired" into a `sessionExpired` event, skipping Shaka's multi-minute retry backoff.
   * Throws a 1001 BAD_HTTP_STATUS to abort retries, so the failure still surfaces as an `error` if unconsumed. */
  private installSessionExpiredFilter(): void {
    if (!this.player) return;
    const ne = this.player.getNetworkingEngine?.();
    if (!ne) return;
    ne.registerResponseFilter((type, response) => {
      if (response?.status !== 410) return;
      const RequestType = shaka.net.NetworkingEngine.RequestType;
      // SEGMENT covers init + media segments (the basic enum doesn't
      // split them — that's only on AdvancedRequestType).
      if (type !== RequestType.SEGMENT && type !== RequestType.MANIFEST) {
        return;
      }
      let body: { code?: string } | null = null;
      try {
        const decoder = new TextDecoder('utf-8');
        body = JSON.parse(decoder.decode(response.data));
      } catch { /* malformed body — fall through and trust the status */ }
      if (body?.code && body.code !== 'session_expired') return;
      this.sessionExpiredInFlight = true;
      // Covers Shaka's retry burst (the filter throws on each 410); cleared after a tick so unrelated errors aren't suppressed.
      setTimeout(() => { this.sessionExpiredInFlight = false; }, 2000);
      this.emit('sessionExpired', undefined);
      throw new shaka.util.Error(
        shaka.util.Error.Severity.CRITICAL,
        shaka.util.Error.Category.NETWORK,
        shaka.util.Error.Code.BAD_HTTP_STATUS,
        response.uri,
        410,
        response.data,
        type,
      );
    });
  }

  async destroy(): Promise<void> {
    // Remove video element listeners
    if (this.video) {
      for (const { event, handler } of this.videoListeners) {
        this.video.removeEventListener(event, handler);
      }
    }
    this.videoListeners = [];
    this.muteGate?.dispose();
    this.muteGate = null;
    if (this.video) this.video.muted = this.userMuted;

    // Remove Shaka event listeners
    if (this.player) {
      for (const { event, handler } of this.shakaListeners) {
        this.player.removeEventListener(event, handler);
      }
    }
    this.shakaListeners = [];

    // Tear down Shaka
    if (this.player) {
      await this.player.destroy();
      this.player = null;
    }

    this.video = null;
    this.clearHandlers();
  }

  async load(url: string, startTime?: number, mimeType?: string, _headers?: Record<string, string>): Promise<void> {
    if (!this.player) throw new Error('ShakaEngine not initialised');
    this.resetFirstFrame();
    this.presentPausedFrame = this.startPaused;
    this.startPaused = false;
    this.shakaBuffering = false;
    this.sessionExpiredInFlight = false;
    this.networkRetries = 0;
    this.sideloadedTextTracks.clear();
    this.loading = this.player.load(url, startTime, mimeType);
    await this.loading;
  }

  startPaused = false;
  private presentPausedFrame = false;

  /** `firstFrame` once the compositor has painted the current frame. */
  private emitFirstFrameWhenPainted(): void {
    const video = this.video;
    if (this.firstFrameEmitted || !video) return;
    const rvfc = video.requestVideoFrameCallback;
    if (typeof rvfc === 'function') rvfc.call(video, () => this.emitFirstFrameOnce());
    else this.emitFirstFrameOnce();
  }

  /** The load in flight or last made: an audio switch waits for it. */
  private loading: Promise<void> | null = null;

  async unload(): Promise<void> {
    if (this.player) {
      await this.player.unload();
    }
  }

  // ─── Playback ──────────────────────────────────────────────────────

  async play(): Promise<void> {
    await this.video?.play();
  }

  async pause(): Promise<void> {
    this.video?.pause();
  }

  async seek(position: number): Promise<void> {
    if (this.video) {
      this.video.currentTime = position;
    }
  }

  // ─── State (sync getters / setters) ────────────────────────────────

  get currentTime(): number {
    return this.video?.currentTime ?? 0;
  }

  get duration(): number {
    const d = this.video?.duration ?? 0;
    return isFinite(d) ? d : 0;
  }

  get paused(): boolean {
    return this.video?.paused ?? true;
  }

  override get seekRange(): SeekRange {
    const seekable = this.video?.seekable;
    if (!seekable || seekable.length === 0) return { start: 0, end: this.currentTime };
    return { start: seekable.start(0), end: seekable.end(seekable.length - 1) };
  }

  get buffered(): number {
    const buf = this.video?.buffered;
    if (!buf || buf.length === 0) return 0;
    return buf.end(buf.length - 1);
  }

  get playbackRate(): number {
    return this.video?.playbackRate ?? 1;
  }
  set playbackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate;
  }

  get volume(): number {
    return this.video?.volume ?? 1;
  }
  readonly supportsVolume = true;

  set volume(v: number) {
    if (this.video) this.video.volume = v;
  }

  get muted(): boolean {
    return this.userMuted;
  }
  set muted(m: boolean) {
    this.userMuted = m;
    if (!this.video) return;
    const before = this.video.muted;
    this.video.muted = m || this.gated;
    if (this.video.muted === before) this.emitVolume();
  }

  setMuteRanges(ranges: readonly TimeRange[]): void {
    this.muteRanges = ranges;
    this.muteGate?.setRanges(ranges);
  }

  private emitVolume(): void {
    const volume = this.video?.volume ?? 1;
    this.lastVolumeEvent = { volume, muted: this.userMuted };
    this.emit('volumechange', this.lastVolumeEvent);
  }

  // ─── Audio tracks ──────────────────────────────────────────────────

  getAudioTracks(): AudioTrack[] {
    if (!this.player) return [];

    const variants = this.player.getVariantTracks();

    // Deduplicate by audioId (each audio track appears in multiple variants
    // for different video qualities).
    const seen = new Map<number, shaka.extern.Track>();
    for (const v of variants) {
      if (v.audioId != null && !seen.has(v.audioId)) {
        seen.set(v.audioId, v);
      }
    }

    const activeAudioId = variants.find((v) => v.active)?.audioId;
    return Array.from(seen.entries()).map(([audioId, v]) => ({
      id: `shaka-${audioId}`,
      label: `${v.language ?? 'und'} (${v.audioCodec ?? '?'}${v.channelsCount ? ' ' + v.channelsCount + 'ch' : ''})`,
      language: v.language ?? 'und',
      selected: audioId === activeAudioId,
    }));
  }

  async selectAudioTrack(id: string): Promise<void> {
    if (!this.player || !id.startsWith('shaka-')) return;
    // A switch made during load() is reported active while the rendition it opened on plays.
    await this.loading?.catch(() => {});

    const audioId = parseInt(id.replace('shaka-', ''), 10);
    const variants = this.player.getVariantTracks();
    const active = variants.find((v) => v.active);

    // Prefer a variant that keeps the current videoId (quality) while switching audio.
    const target =
      variants.find((v) => v.audioId === audioId && v.videoId === active?.videoId)
      ?? variants.find((v) => v.audioId === audioId);

    if (target) {
      const wasPlaying = this.video ? !this.video.paused : false;
      this.player.selectVariantTrack(target, /* clearBuffer= */ true);
      if (wasPlaying) this.video?.play().catch(() => {});
    }
  }

  // ─── Subtitles ─────────────────────────────────────────────────────

  /** Text tracks sideloaded into a stream that carries no rendition for them
   *  (DirectPlay), by URL; Shaka drops them with the manifest, see {@link load}. */
  private sideloadedTextTracks = new Map<string, shaka.extern.TextTrack>();

  async addTextTrack(
    url: string,
    language: string,
    label: string,
    forced?: boolean,
    index = 0,
  ): Promise<TextTrackHandle> {
    if (!this.player) throw new Error('ShakaEngine not initialised');
    // Matched by (language, forced), then `index` among tracks sharing both; codes are normalised (`en` vs `eng`) and another language is never a substitute.
    const want = normalizeLangCode(language);
    const sideloaded = new Set([...this.sideloadedTextTracks.values()].map((t) => t.id));
    const renditions = this.player.getTextTracks().filter((t) => !sideloaded.has(t.id));
    const sameLangForced = renditions.filter(
      (t) => normalizeLangCode(t.language) === want && !!t.forced === !!forced,
    );
    const rendition =
      sameLangForced[index] ??
      sameLangForced[0] ??
      renditions.find((t) => normalizeLangCode(t.language) === want);
    if (rendition) return rendition;
    if (!url) throw new Error(`No text track for ${language}`);
    // No rendition (a raw DirectPlay file): attach the WebVTT itself.
    const known = this.sideloadedTextTracks.get(url);
    if (known) return known;
    const track = await this.player.addTextTrackAsync(
      url, language, 'subtitles', 'text/vtt', undefined, label, !!forced,
    );
    this.sideloadedTextTracks.set(url, track);
    return track;
  }

  selectTextTrack(track: TextTrackHandle | null): void {
    if (!track) return;
    this.player?.selectTextTrack(track as shaka.extern.TextTrack);
  }

  setTextVisibility(visible: boolean): void {
    // Shaka 5 has no visibility flag: selecting a track shows it, deselecting hides it.
    if (visible) return;
    try {
      this.player?.selectTextTrack(null);
    } catch {
      // no player / no active text track
    }
  }

  // ─── Quality (variant tracks) ──────────────────────────────────────

  getVariantTracks(): VariantTrack[] {
    return this.player?.getVariantTracks() ?? [];
  }

  selectVariantTrack(track: VariantTrack, clearBuffer?: boolean): void {
    this.player?.selectVariantTrack(track, clearBuffer);
  }

  configure(config: EngineConfig): void {
    const { preferredAudioLanguage, ...rest } = config;
    this.player?.configure(
      preferredAudioLanguage === undefined
        ? rest
        : { ...rest, preferredAudio: preferredAudioLanguage ? [{ language: preferredAudioLanguage }] : [] },
    );
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  getStats(): EngineStats {
    const shakaStats = this.player?.getStats() as
      | { droppedFrames?: number; streamBandwidth?: number }
      | undefined;

    const activeTrack = this.player?.getVariantTracks()?.find((t) => t.active);

    return {
      droppedFrames: shakaStats?.droppedFrames ?? 0,
      streamBandwidth: shakaStats?.streamBandwidth,
      activeVariant: activeTrack
        ? {
            width: activeTrack.width ?? undefined,
            height: activeTrack.height ?? undefined,
            videoBandwidth: activeTrack.videoBandwidth ?? undefined,
            audioBandwidth: activeTrack.audioBandwidth ?? undefined,
            videoCodec: activeTrack.videoCodec ?? undefined,
            audioCodec: activeTrack.audioCodec ?? undefined,
          }
        : undefined,
    };
  }

  override async getQoeSample(): Promise<EngineQoeSample | null> {
    if (!this.player || !this.video) return null;
    const stats = this.player.getStats();
    const track = this.player.getVariantTracks().find((t) => t.active);
    const num = (n: number | undefined | null) => (Number.isFinite(n) ? (n as number) : null);
    return {
      engine: 'shaka',
      cmcd: true,
      droppedFrames: num(stats.droppedFrames),
      decodedFrames: num(stats.decodedFrames),
      bandwidthBps: num(stats.estimatedBandwidth),
      bufferAheadS: bufferAheadOf(this.video),
      variantBitrate: num(track?.bandwidth) || null,
      width: num(track?.width),
      height: num(track?.height),
      videoCodec: track?.videoCodec ?? null,
      decoderName: null,
      hwDecoder: null,
    };
  }

  // ─── Internal: bridge native events ────────────────────────────────

  private addVideoListener(event: string, handler: EventListener): void {
    this.video!.addEventListener(event, handler);
    this.videoListeners.push({ event, handler });
  }

  private addShakaListener(event: string, handler: EventListener): void {
    this.player!.addEventListener(event, handler);
    this.shakaListeners.push({ event, handler });
  }

  private bridgeVideoEvents(): void {
    const video = this.video!;

    // Time updates
    this.addVideoListener('timeupdate', () => {
      const buf = video.buffered;
      const buffered = buf.length > 0 ? buf.end(buf.length - 1) : 0;
      this.emit('timeUpdate', {
        position: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        buffered,
      });
    });

    // Buffered progress
    this.addVideoListener('progress', () => {
      const buf = video.buffered;
      const buffered = buf.length > 0 ? buf.end(buf.length - 1) : 0;
      this.emit('timeUpdate', {
        position: video.currentTime,
        duration: isFinite(video.duration) ? video.duration : 0,
        buffered,
      });
    });

    // State transitions
    this.addVideoListener('play', () => {
      this.bufferingEmitted = false;
      this.emit('stateChanged', { state: 'playing' });
      if (this.shakaBuffering && !video.paused) this.emitBuffering();
    });

    this.addVideoListener('pause', () => {
      this.bufferingEmitted = false;
      this.emit('stateChanged', { state: 'paused' });
    });

    this.addVideoListener('waiting', () => this.emitBuffering());

    this.addVideoListener('stalled', () => {
      // Network stall — show buffering if not paused and buffer is nearly empty
      if (!video.paused && video.buffered.length > 0) {
        const bufferedAhead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        if (bufferedAhead < 1) this.emitBuffering();
      }
    });

    this.addVideoListener('playing', () => {
      this.emitPlayingUnlessStarved();
      // Gated on requestVideoFrameCallback: the DOM 'playing' event can precede the first paint.
      this.emitFirstFrameWhenPainted();
    });

    // A paused video has its current frame once readyState reaches HAVE_CURRENT_DATA; rVFC would wait for
    // a frame that never comes on Safari, which only fires it while playing.
    for (const event of ['loadeddata', 'seeked']) {
      this.addVideoListener(event, () => {
        if (this.presentPausedFrame && video.paused && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) this.emitFirstFrameOnce();
      });
    }

    this.addVideoListener('canplay', () => {
      // Resolve buffering state when enough data is available
      if (!video.paused) this.emitPlayingUnlessStarved();
    });

    this.addVideoListener('ended', () => {
      this.emit('stateChanged', { state: 'ended' });
      this.emit('ended', undefined);
    });

    // Output level / mute — the single mirror back to the UI slider.
    // A gate-only flip of `video.muted` is not a user change: skip an unchanged payload.
    this.addVideoListener('volumechange', () => {
      const last = this.lastVolumeEvent;
      if (last && last.volume === video.volume && last.muted === this.userMuted) return;
      this.emitVolume();
    });

    for (const event of ['seeking', 'seeked', 'play', 'pause', 'ratechange', 'timeupdate', 'loadedmetadata']) {
      this.addVideoListener(event, () => this.muteGate?.sync());
    }

    // Video element errors
    this.addVideoListener('error', () => {
      const e = video.error;
      console.error('[Shaka] Video element error:', e?.code, e?.message);
      this.emit('error', {
        source: 'media',
        code: e?.code ?? 0,
        message: e?.message ?? `Video error code ${e?.code}`,
        variant: this.activeVariantString(),
      });
      this.emit('stateChanged', { state: 'error' });
    });
  }

  /** Variant at error time (`hvc1.1.6.L120 1920×1080 @3.0Mb/s · ec-3`), shown on the error card to expose the failing codec/level. */
  private activeVariantString(): string | undefined {
    const v = this.player?.getVariantTracks?.().find((t: any) => t.active);
    if (!v) return undefined;
    const parts: string[] = [];
    if (v.videoCodec) parts.push(String(v.videoCodec));
    if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
    if (v.videoBandwidth || v.bandwidth) {
      parts.push(`@${((v.videoBandwidth || v.bandwidth) / 1e6).toFixed(1)}Mb/s`);
    }
    if (v.audioCodec) parts.push(`· ${v.audioCodec}`);
    return parts.length ? parts.join(' ') : undefined;
  }

  private bufferingEmitted = false;
  private shakaBuffering = false;

  /** Shaka fires `buffering` once per episode, so DOM events must not clear the flag while it is open. */
  private emitPlayingUnlessStarved(): void {
    if (this.shakaBuffering && this.video && !this.video.paused) {
      this.emitBuffering();
      return;
    }
    this.bufferingEmitted = false;
    this.emit('stateChanged', { state: 'playing' });
  }

  private emitBuffering(): void {
    if (this.bufferingEmitted) return;
    this.bufferingEmitted = true;
    this.emit('stateChanged', { state: 'buffering' });
  }

  private bridgeShakaEvents(): void {
    // Shaka holds playback at its rebuffering goal without a DOM waiting/stalled event.
    this.addShakaListener('segmentappended', () => { this.networkRetries = 0; });

    this.addShakaListener('buffering', (ev) => {
      const { buffering } = ev as unknown as { buffering: boolean };
      const video = this.video;
      this.shakaBuffering = buffering;
      if (!video || video.ended) return;
      if (buffering) {
        if (!video.paused) this.emitBuffering();
      } else {
        this.bufferingEmitted = false;
        this.emit('stateChanged', { state: video.paused ? 'paused' : 'playing' });
      }
    });

    // Shaka error events (separate from HTMLVideoElement errors)
    this.addShakaListener('error', (ev) => {
      const detail = (ev as unknown as { detail?: shaka.util.Error }).detail;
      if (this.sessionExpiredInFlight) {
        // 410 recovery is taking over; no error overlay before the reload.
        return;
      }
      // VOD streaming stops on a network failure while the buffer still plays: retry before failing the session.
      if (detail?.category === 1 && !isClientHttpError(detail)
        && this.networkRetries < MAX_NETWORK_RETRIES && this.player?.retryStreaming(NETWORK_RETRY_DELAY_S)) {
        this.networkRetries++;
        console.warn('[Shaka] network error, retrying streaming', detail.code, this.networkRetries);
        return;
      }
      console.error('[Shaka] Player error:', detail?.code, detail?.category, detail?.message, detail?.data);
      this.emit('error', {
        source: 'shaka',
        code: detail?.code ?? 0,
        category: detail?.category,
        severity: detail?.severity,
        data: detail?.data,
        message: detail?.message ?? `Shaka error ${detail?.code}`,
        variant: this.activeVariantString(),
      });
      this.emit('stateChanged', { state: 'error' });
    });

    // Forwarded so the player upgrades from the si-* streamInfo fallback to the real shaka-* tracks once available.
    const emitAudioTracks = () => {
      const tracks = this.getAudioTracks();
      if (tracks.length > 0) this.emit('audioTracksChanged', { tracks });
    };
    this.addShakaListener('manifestparsed', emitAudioTracks);
    this.addShakaListener('trackschanged', emitAudioTracks);
    this.addShakaListener('adaptation', emitAudioTracks);
    this.addShakaListener('variantchanged', emitAudioTracks);
  }
}
