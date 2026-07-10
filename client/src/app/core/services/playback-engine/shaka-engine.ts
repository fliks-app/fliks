import shaka from 'shaka-player';
import {
  AbstractPlaybackEngine,
  AudioTrack,
  EngineStats,
  PlaybackEngine,
  PlaybackState,
} from './playback-engine';
import { normalizeLangCode } from '../../utils/language.utils';

/**
 * Shaka Player implementation of the PlaybackEngine interface.
 *
 * Wraps shaka.Player and the underlying HTMLVideoElement into the unified
 * engine API so player.ts doesn't interact with Shaka directly.
 *
 * This is a plain TypeScript class with NO Angular dependencies.
 */
export class ShakaEngine extends AbstractPlaybackEngine implements PlaybackEngine {

  private player: shaka.Player | null = null;
  private video: HTMLVideoElement | null = null;

  /** Refs kept so we can removeEventListener on destroy. */
  private videoListeners: Array<{ event: string; handler: EventListener }> = [];
  private shakaListeners: Array<{ event: string; handler: EventListener }> = [];

  /** Set briefly after the 410 response filter has emitted
   *  `sessionExpired`. Shaka also surfaces the thrown filter error
   *  through its `error` event — we suppress the bridged `error`
   *  emission for one tick so the UI doesn't flash a fatal-error overlay
   *  on top of the in-flight recovery. */
  private sessionExpiredInFlight = false;

  // ─── Lifecycle ──────────────────────────────────────────────────────

  async init(container: HTMLElement): Promise<void> {
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      throw new Error('Shaka Player: browser not supported');
    }

    const video = container as HTMLVideoElement;
    this.video = video;

    this.player = new shaka.Player();

    // Switch to UITextDisplayer (DOM-based) before attach so the player
    // never instantiates the default NativeTextDisplayer. UITextDisplayer
    // renders every line of a multi-line cue as a `.shaka-text-wrapper`
    // flex child of `.shaka-text-container`, so font-size / line-height /
    // inter-line spacing become real CSS properties we can override —
    // unlike native VTTCue rendering, where Shaka flattens nested cues
    // into separate VTTCues whose stacking the browser controls.
    if (video.parentElement) {
      this.player.setVideoContainer(video.parentElement);
      this.player.configure({
        textDisplayFactory: (player: shaka.Player) =>
          new shaka.text.UITextDisplayer(player),
      } as any);
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
    } as any);

    this.installSessionExpiredFilter();
    this.bridgeVideoEvents();
    this.bridgeShakaEvents();
  }

  /**
   * NetworkingEngine response filter that turns the backend's 410
   * "session_expired" body into a synchronous `sessionExpired` engine
   * event. Without it Shaka would retry the segment per its
   * `streaming.retryParameters` schedule (~5 attempts, exponential
   * backoff → ~2 min before the heartbeat-driven recovery #302 kicks
   * in). Reacting on the very first 410 collapses that window down to
   * the time it takes to call /playback-info + reload (~1 s).
   *
   * Throwing a 1001 BAD_HTTP_STATUS error from the filter aborts
   * Shaka's retry loop and surfaces as a regular `error` event, so the
   * engine never silently swallows the failure if no listener consumes
   * the `sessionExpired` signal.
   */
  private installSessionExpiredFilter(): void {
    if (!this.player) return;
    const ne = this.player.getNetworkingEngine?.();
    if (!ne) return;
    ne.registerResponseFilter((type, response: any) => {
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
      // Window covers Shaka's own retry burst (the filter throws on
      // every retried 410); cleared after a tick so a later, unrelated
      // error from the bridge isn't accidentally suppressed.
      setTimeout(() => { this.sessionExpiredInFlight = false; }, 2000);
      this.emit('sessionExpired', undefined as any);
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
    this.sessionExpiredInFlight = false;
    await this.player.load(url, startTime, mimeType);
  }

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
  set volume(v: number) {
    if (this.video) this.video.volume = v;
  }

  get muted(): boolean {
    return this.video?.muted ?? false;
  }
  set muted(m: boolean) {
    if (this.video) this.video.muted = m;
  }

  // ─── Audio tracks ──────────────────────────────────────────────────

  getAudioTracks(): AudioTrack[] {
    if (!this.player) return [];

    const variants = this.player.getVariantTracks();

    // Deduplicate by audioId (each audio track appears in multiple variants
    // for different video qualities).
    const seen = new Map<number, any>();
    for (const v of variants) {
      if (v.audioId != null && !seen.has(v.audioId)) {
        seen.set(v.audioId, v);
      }
    }

    return Array.from(seen.entries()).map(([audioId, v]) => ({
      id: `shaka-${audioId}`,
      label: `${v.language ?? 'und'} (${v.audioCodec ?? '?'}${v.channelsCount ? ' ' + v.channelsCount + 'ch' : ''})`,
      language: v.language ?? 'und',
    }));
  }

  async selectAudioTrack(id: string): Promise<void> {
    if (!this.player || !id.startsWith('shaka-')) return;

    const audioId = parseInt(id.replace('shaka-', ''), 10);
    const variants = this.player.getVariantTracks();
    const active = variants.find((v: any) => v.active);

    // Prefer a variant that keeps the current videoId (quality) while switching audio.
    const target =
      variants.find((v: any) => v.audioId === audioId && v.videoId === active?.videoId)
      ?? variants.find((v: any) => v.audioId === audioId);

    if (target) {
      const wasPlaying = this.video ? !this.video.paused : false;
      this.player.selectVariantTrack(target, /* clearBuffer= */ true);
      if (wasPlaying) this.video?.play().catch(() => {});
    }
  }

  // ─── Subtitles ─────────────────────────────────────────────────────

  async addTextTrack(
    _url: string,
    language: string,
    _label: string,
    forced?: boolean,
  ): Promise<any> {
    if (!this.player) throw new Error('ShakaEngine not initialised');
    // Subtitles ship as HLS SUBTITLES renditions in the manifest. Shaka
    // parses them into text tracks and still renders them through the
    // configured UITextDisplayer (so multi-line cue styling is preserved),
    // so we match the chosen track by (language, forced) instead of loading
    // a sidecar VTT. Match on normalised language codes — the manifest
    // LANGUAGE may be 2-letter (`en`) while the option carries 3-letter
    // (`eng`). Falls back to a language-only match, then the first track.
    const want = normalizeLangCode(language);
    const tracks: any[] = this.player.getTextTracks();
    return (
      tracks.find((t) => normalizeLangCode(t.language) === want && !!t.forced === !!forced) ??
      tracks.find((t) => normalizeLangCode(t.language) === want) ??
      tracks[0] ??
      null
    );
  }

  selectTextTrack(track: any): void {
    if (!track) return;
    this.player?.selectTextTrack(track);
    try {
      (this.player as any)?.setTextVisibility(true);
    } catch {
      // Shaka may throw if no text tracks exist
    }
  }

  setTextVisibility(visible: boolean): void {
    // Shaka 5.x merged text visibility into track selection: the standalone
    // `setTextVisibility(boolean)` method was removed, so the old bare call
    // threw (silently caught) and disabling subtitles never took effect.
    // Showing is handled by `selectTextTrack(track)` in selectTextTrack();
    // to hide, deselect the track with `selectTextTrack(null)`.
    if (visible) return;
    try {
      (this.player as any)?.selectTextTrack(null);
    } catch {
      // no player / no active text track
    }
  }

  // ─── Quality (variant tracks) ──────────────────────────────────────

  getVariantTracks(): any[] {
    return this.player?.getVariantTracks() ?? [];
  }

  selectVariantTrack(track: any, clearBuffer?: boolean): void {
    this.player?.selectVariantTrack(track, clearBuffer);
  }

  configure(config: any): void {
    this.player?.configure(config);
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  getStats(): EngineStats {
    const shakaStats = this.player?.getStats() as
      | { droppedFrames?: number; streamBandwidth?: number }
      | undefined;

    const activeTrack = this.player?.getVariantTracks()?.find((t: any) => t.active);

    return {
      droppedFrames: shakaStats?.droppedFrames ?? 0,
      streamBandwidth: shakaStats?.streamBandwidth,
      activeVariant: activeTrack
        ? {
            width: activeTrack.width ?? undefined,
            height: activeTrack.height ?? undefined,
            videoBandwidth: activeTrack.videoBandwidth ?? undefined,
            audioBandwidth: (activeTrack as any).audioBandwidth ?? undefined,
            videoCodec: activeTrack.videoCodec ?? undefined,
            audioCodec: activeTrack.audioCodec ?? undefined,
          }
        : undefined,
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
      this.emit('stateChanged', { state: 'playing' });
    });

    this.addVideoListener('pause', () => {
      this.emit('stateChanged', { state: 'paused' });
    });

    this.addVideoListener('waiting', () => {
      this.emit('stateChanged', { state: 'buffering' });
    });

    this.addVideoListener('stalled', () => {
      // Network stall — show buffering if not paused and buffer is nearly empty
      if (!video.paused && video.buffered.length > 0) {
        const bufferedAhead = video.buffered.end(video.buffered.length - 1) - video.currentTime;
        if (bufferedAhead < 1) {
          this.emit('stateChanged', { state: 'buffering' });
        }
      }
    });

    this.addVideoListener('playing', () => {
      this.emit('stateChanged', { state: 'playing' });
      // Emit firstFrame ONCE, gated on requestVideoFrameCallback so it
      // fires only after a frame has actually been presented to the
      // compositor (the DOM 'playing' event can precede the first paint).
      if (!this.firstFrameEmitted) {
        const rvfc = (video as any).requestVideoFrameCallback;
        const fire = () => this.emitFirstFrameOnce();
        if (typeof rvfc === 'function') rvfc.call(video, fire);
        else fire();
      }
    });

    this.addVideoListener('canplay', () => {
      // Resolve buffering state when enough data is available
      if (!video.paused) {
        this.emit('stateChanged', { state: 'playing' });
      }
    });

    this.addVideoListener('ended', () => {
      this.emit('stateChanged', { state: 'ended' });
      this.emit('ended', undefined as any);
    });

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

  /** Human-readable summary of the variant playing at error time —
   *  `hvc1.1.6.L120 1920×1080 @3.0Mb/s · ec-3`. Surfaced on the error card
   *  so a decode failure shows exactly which codec/level/tier the browser
   *  choked on (the whole point of the Safari HEVC diagnosis). */
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

  private bridgeShakaEvents(): void {
    // Shaka error events (separate from HTMLVideoElement errors)
    this.addShakaListener('error', (e: any) => {
      const detail = e.detail;
      if (this.sessionExpiredInFlight) {
        // 410 recovery is taking over — swallow the fatal-error event
        // so the UI doesn't render the error overlay before the engine
        // reloads with a fresh sid.
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

    // Fires when manifest is parsed / variants become available / adaptation
    // happens. Forward as audioTracksChanged so the player can upgrade from
    // the si-* streamInfo fallback (used when tracks aren't ready at startup)
    // to the real shaka-* tracks as soon as Shaka has them.
    const emitAudioTracks = () => {
      const tracks = this.getAudioTracks();
      if (tracks.length === 0) return;
      const activeAudioId = this.player
        ?.getVariantTracks()
        ?.find((v: any) => v.active)?.audioId;
      this.emit('audioTracksChanged', {
        tracks: tracks.map((t) => ({
          ...t,
          selected: t.id === `shaka-${activeAudioId}`,
        })) as any,
      });
    };
    this.addShakaListener('manifestparsed', emitAudioTracks);
    this.addShakaListener('trackschanged', emitAudioTracks);
    this.addShakaListener('adaptation', emitAudioTracks);
    this.addShakaListener('variantchanged', emitAudioTracks);
  }
}
