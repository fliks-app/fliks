import {
  AbstractPlaybackEngine,
  type PlaybackEngine,
  type AudioTrack,
  type EngineStats,
  type EngineQoeSample,
  type EngineConfig,
  type TextTrackHandle,
  type TextTrackPick,
  pausedFlagForState,
} from './playback-engine';
import {
  toNativeSubtitleStyle,
  type NativeSubtitleStyle,
  type SubtitleStyleSettings,
} from '../../utils/subtitle-presets';
import { normalizeLangCode } from '../../utils/language.utils';
import type { TimeRange } from '../../utils/edl-policy';
import {
  desktopBridge,
  type DesktopEvent,
  type DesktopSubtitleTrack,
  type FliksDesktopApi,
} from '../../plugins/desktop-player.bridge';

/** What the player picked: the handle from addTextTrack plus `image` and, for an
 *  embedded sub, `embIndex` (the container stream index). */
interface DesiredSubtitle {
  language: string;
  forced: boolean;
  image: boolean;
  /** Ordinal among tracks sharing (language, forced); last-resort identity. */
  index: number;
  /** URL the sidecar was added from; null when nothing was loaded (bitmap subs). */
  source: string | null;
  embIndex: number | null;
}

type SubtitleHandle = Pick<DesiredSubtitle, 'language' | 'forced' | 'index' | 'source'>;

/** PlaybackEngine backed by the Electron shell's embedded mpv (`window.fliksDesktop`), mirroring NativeEngine: mpv renders behind the transparent UI. */
export class DesktopEngine extends AbstractPlaybackEngine implements PlaybackEngine {
  private readonly bridge: FliksDesktopApi = desktopBridge();
  private unsubscribe: (() => void) | null = null;

  private _currentTime = 0;
  private _duration = 0;
  private _buffered = 0;
  private _paused = true;
  private _playbackRate = 1;
  private _volume = 1;
  private _muted = false;
  private _audioTracks: AudioTrack[] = [];

  /** Set in destroy() so a leaked late event (the mpv player is a persistent
   *  singleton) can't drive a torn-down engine into recovery. */
  private dead = false;

  private _initialized = false;

  // ── Subtitles ── text tracks load sidecar via `sub-add`; picks resolve against mpv's track list by identity (see findSubtitle).
  private _desiredSubtitle: DesiredSubtitle | null = null;
  private _nativeSubtitleTracks: DesktopSubtitleTrack[] = [];
  /** mpv's own audio track ids, indexed parallel to the `audio-<i>` ids the
   *  player expects (mpv ids are bare ints; the player keys off the prefix). */
  private _mpvAudioIds: string[] = [];
  private _fullscreen = false;
  /** Preferred audio language (from configure()); passed to mpv as `alang` at
   *  load so it auto-picks the matching rendition on every reconfig. */
  private _preferredAudioLanguage?: string;
  private _videoCrop?: string;

  private _subtitleStyle: NativeSubtitleStyle | null = null;
  private _fillScreen = false;

  // ── Lifecycle ──

  async init(_container: HTMLElement): Promise<void> {
    // The video window + mpv already exist in the Electron main process; just
    // wire the event stream (and re-apply any style set before init).
    this.subscribe();
    this._initialized = true;
    if (this._subtitleStyle) {
      this.bridge.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    this.dead = true;
    this._initialized = false;
    // The compositor window is the app window: leave fullscreen with the
    // player, whatever route change tore it down.
    if (this._fullscreen) await this.setFullscreen(false);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearHandlers();
    await this.bridge.stop().catch(() => {});
  }

  async load(
    url: string,
    startTime?: number,
    _mimeType?: string,
    headers?: Record<string, string>,
  ): Promise<void> {
    if (this.dead) return;
    this.resetFirstFrame();
    // Fresh media → fresh tracks; drop the prior list/id map so a same-count
    // track emission for the new stream isn't swallowed as a no-op downstream.
    this._audioTracks = [];
    this._mpvAudioIds = [];
    this._nativeSubtitleTracks = [];
    await this.bridge.load({
      url,
      startTime,
      headers,
      audioLanguage: this._preferredAudioLanguage,
      videoCrop: this._videoCrop,
    });
    if (this._subtitleStyle) {
      await this.bridge.setSubtitleStyle(this._subtitleStyle);
    }
    if (this._fillScreen) {
      await this.bridge.setFillScreen(true).catch(() => {});
    }
  }

  async unload(): Promise<void> {
    await this.bridge.stop();
    this._currentTime = 0;
    this._duration = 0;
  }

  // ── Playback ──

  async play(): Promise<void> {
    if (this.dead) return;
    await this.bridge.play();
    this._paused = false;
  }

  async pause(): Promise<void> {
    if (this.dead) return;
    await this.bridge.pause();
    this._paused = true;
  }

  async seek(position: number): Promise<void> {
    if (this.dead) return;
    await this.bridge.seek(position);
    // No optimistic _currentTime: pollSeekConverge would drop seekLocked before the seek lands; the real position arrives via timeUpdate.
  }

  // ── State ──

  get currentTime(): number {
    return this._currentTime;
  }
  get duration(): number {
    return this._duration;
  }
  get paused(): boolean {
    return this._paused;
  }
  get buffered(): number {
    return this._buffered;
  }
  get playbackRate(): number {
    return this._playbackRate;
  }
  set playbackRate(rate: number) {
    this._playbackRate = rate;
    this.bridge.setPlaybackRate(rate).catch(() => {});
  }

  // Desktop has an in-app volume control (unlike mobile, which defers to the
  // OS slider): drive mpv's volume/mute directly.
  get volume(): number {
    return this._volume;
  }
  readonly supportsVolume = true;

  set volume(v: number) {
    this._volume = v;
    this.bridge.setVolume(Math.round(v * 100)).catch(() => {});
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }
  get muted(): boolean {
    return this._muted;
  }
  set muted(m: boolean) {
    this._muted = m;
    this.bridge.setMuted(m).catch(() => {});
    this.emit('volumechange', { volume: this._volume, muted: this._muted });
  }

  // ── Audio tracks ──

  getAudioTracks(): AudioTrack[] {
    return this._audioTracks;
  }

  async selectAudioTrack(id: string): Promise<void> {
    // The player sends `audio-<i>` ids; translate back to mpv's own aid.
    const idx = parseInt(id.replace(/^audio-/, ''), 10);
    const mpvId = this._mpvAudioIds[idx] ?? String(idx + 1);
    await this.bridge.selectAudioTrack(mpvId);
  }

  /** Toggle the native (SDL) compositor window fullscreen. */
  async setFullscreen(enabled: boolean): Promise<void> {
    this._fullscreen = enabled;
    await this.bridge.setFullscreen(enabled).catch(() => {});
  }
  get fullscreen(): boolean {
    return this._fullscreen;
  }

  // ── Subtitles ──

  async addTextTrack(
    url: string,
    language: string,
    label: string,
    forced = false,
    index = 0,
  ): Promise<SubtitleHandle> {
    // Sidecar `sub-add` (idempotent per URL) since an HLS rendition makes mpv re-read the VTT per seek, stacking cues.
    // Load the stored file: mpv's VTT reader drops cue placement, its SRT/ASS readers keep `{\an8}` and other positioning tags.
    const source = url?.replace(/(\/subtitles\/\d+)(?=[?#]|$)/, '$1/download') || null;
    if (source) {
      await this.bridge.subAdd(source, label, language).catch(() => {});
      // The new track is in mpv's list now; read it rather than wait for the event.
      this._nativeSubtitleTracks = await this.bridge
        .getSubtitleTracks()
        .catch(() => this._nativeSubtitleTracks);
    }
    return { language, forced, index, source };
  }

  selectTextTrack(handle: TextTrackHandle | null): void {
    const track = handle as TextTrackPick | null;
    this._desiredSubtitle =
      track && typeof track === 'object' && track.language
        ? {
            language: track.language,
            forced: !!track.forced,
            image: !!track.image,
            index: Number(track.index) || 0,
            source: track.source ?? null,
            embIndex: track.embIndex ?? null,
          }
        : null;
    this.resolveSubtitle();
  }

  setTextVisibility(visible: boolean): void {
    if (!visible) {
      this._desiredSubtitle = null;
      this.bridge.selectSubtitleTrack(null).catch(() => {});
    }
  }

  /** Apply the desired subtitle; nothing desired or unresolvable asserts off, since mpv auto-selects on its own. */
  private resolveSubtitle(): void {
    const match = this._desiredSubtitle ? this.findSubtitle(this._desiredSubtitle) : undefined;
    this.bridge.selectSubtitleTrack(match?.id ?? null).catch(() => {});
  }

  /** Identity order: sidecar URL, then embedded stream index; the (language, forced, image) ordinal only for picks carrying neither. */
  private findSubtitle(want: DesiredSubtitle): DesktopSubtitleTrack | undefined {
    const tracks = this._nativeSubtitleTracks;
    if (want.source || want.embIndex != null) {
      return (
        tracks.find((t) => want.source != null && t.external && t.source === want.source) ??
        tracks.find((t) => want.embIndex != null && t.ffIndex === want.embIndex)
      );
    }
    const lang = normalizeLangCode(want.language);
    return tracks.filter(
      (t) =>
        normalizeLangCode(t.language) === lang &&
        !!t.forced === want.forced &&
        t.image === want.image,
    )[want.index];
  }

  /** Match NativeEngine.setSubtitleStyle: maps the player's preset keys to the
   *  native style payload and pushes it to mpv. */
  setSubtitleStyle(settings: SubtitleStyleSettings): void {
    this._subtitleStyle = toNativeSubtitleStyle(settings);
    if (this._initialized) {
      this.bridge.setSubtitleStyle(this._subtitleStyle).catch(() => {});
    }
  }

  private _muteRanges: TimeRange[] = [];
  private _sentMuteRanges = '[]';
  private _muteWarned = false;

  setMuteRanges(ranges: readonly TimeRange[]): void {
    this._muteRanges = ranges.map((r) => ({ start: r.start, end: r.end }));
    void this.pushMuteRanges();
  }

  /** The main process re-applies the ranges on every load. Older builds lack the method: logged once. */
  private async pushMuteRanges(): Promise<void> {
    const key = JSON.stringify(this._muteRanges);
    if (key === this._sentMuteRanges) return;
    this._sentMuteRanges = key;
    try {
      if (!this.bridge.setMuteRanges) throw new Error('bridge.setMuteRanges missing');
      await this.bridge.setMuteRanges(this._muteRanges);
    } catch (e) {
      if (!this._muteWarned) console.warn('[desktop-engine] setMuteRanges unavailable', e);
      this._muteWarned = true;
    }
  }

  /** Match NativeEngine.setFillScreen: crop-to-fill instead of letterbox. */
  setFillScreen(fill: boolean): void {
    this._fillScreen = fill;
    this.bridge.setFillScreen(fill).catch(() => {});
  }

  // ── Stats ──

  getStats(): EngineStats {
    return { droppedFrames: 0 };
  }

  /** Null on a stale desktop build or a failed read. */
  override async getQoeSample(): Promise<EngineQoeSample | null> {
    if (this.dead || !this.bridge.getQoe) return null;
    try {
      const q = await this.bridge.getQoe();
      return q && { engine: 'mpv', cmcd: false, ...q };
    } catch {
      return null;
    }
  }

  // ── Tuning ── mpv never switches HLS variants (the rung is pinned via `startQuality`), so only audio language and crop apply.
  configure(config: EngineConfig): void {
    // The language reaches mpv as `alang` on the next load, like Shaka's preferredAudioLanguage.
    if (config && typeof config.preferredAudioLanguage === 'string') {
      this._preferredAudioLanguage = config.preferredAudioLanguage || undefined;
    }
    // Black-bar crop is free at mpv's VO, so the backend copies the bitstream; re-applied on every load.
    if (config && 'videoCrop' in config) {
      this._videoCrop = config.videoCrop || undefined;
    }
  }

  // ── Event bridge ──

  private subscribe(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.bridge.on((event) => this.onEvent(event));
  }

  private onEvent(event: DesktopEvent): void {
    if (this.dead) return;
    switch (event.type) {
      case 'stateChanged': {
        const state = event.payload.state;
        const paused = pausedFlagForState(state);
        if (paused !== undefined) this._paused = paused;
        this.emit('stateChanged', { state });
        if (state === 'ended') this.emit('ended', undefined);
        break;
      }
      case 'timeUpdate': {
        const d = event.payload;
        this._currentTime = d.position;
        this._duration = d.duration;
        this._buffered = d.buffered;
        this.emit('timeUpdate', d);
        // firstFrame comes from 'playback-restart' only: a position delta mis-fires on the stale time-pos a persistent mpv replays after reopen.
        break;
      }
      case 'tracksChanged': {
        const raw = event.payload.audioTracks ?? [];
        // Emit the `audio-<i>` id contract the player keys off; keep mpv's real
        // ids for selectAudioTrack to map back.
        this._mpvAudioIds = raw.map((t) => t.id);
        this._audioTracks = raw.map((t, i) => ({
          id: `audio-${i}`,
          language: t.language,
          label: t.label,
          selected: !!t.selected,
        }));
        this.emit('audioTracksChanged', { tracks: this._audioTracks });
        this._nativeSubtitleTracks = event.payload.subtitleTracks ?? [];
        this.resolveSubtitle();
        break;
      }
      case 'firstFrame': {
        if (this.firstFrameEmitted) break;
        this.emitFirstFrameOnce();
        // A persistent mpv may fire no pause change on a fresh load: assert playing so controls show pause.
        this._paused = false;
        this.emit('stateChanged', { state: 'playing' });
        break;
      }
      case 'error': {
        // mpv can't expose the segment's HTTP status: first error after a frame played tries one session-expired recovery.
        const { code, message, detail } = event.payload;
        if (this.maybeEmitSessionExpired({ code, message })) return;
        // Append the concrete cause mpv logged (TLS, HTTP status, codec) so the error card shows why.
        const composed = detail ? `${message} - ${detail}` : message;
        // code 2 is mpv's TLS/libcurl transport error; source:'media' routes it via the network classifier, not a decode label.
        this.emit(
          'error',
          code === 2 ? { code, message: composed, source: 'media' } : { code, message: composed },
        );
        break;
      }
      default:
        break;
    }
  }
}
