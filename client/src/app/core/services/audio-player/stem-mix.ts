import type { StemKind } from '../api/karaoke.models';

export type StemMode = 'original' | 'guide' | 'instrumental';

export const GUIDE_VOCAL_LEVEL = 0.25;
export const DRIFT_TOLERANCE_S = 0.15;
/** Buffered stems run on their own clock; webOS reports currentTime in 200 ms steps, so correct only past them. */
export const BUFFERED_DRIFT_S = 0.35;

export interface MixGains {
  main: number;
  instrumental: number;
  vocals: number;
}

/** The main element is silent whenever the stems carry the sound. */
export function mixGains(mode: StemMode, vocalLevel: number, stemsLoaded: boolean): MixGains {
  if (mode === 'original' || !stemsLoaded) return { main: 1, instrumental: 0, vocals: 0 };
  return { main: 0, instrumental: 1, vocals: Math.min(1, Math.max(0, vocalLevel)) };
}

/** True when a stem has drifted far enough from the main clock to be seeked. */
export function needsReseek(mainTime: number, stemTime: number): boolean {
  return Math.abs(mainTime - stemTime) > DRIFT_TOLERANCE_S;
}

interface Stem {
  el: HTMLAudioElement;
  gain: GainNode;
}

interface BufferedStem {
  buffer: AudioBuffer | null;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
}

const KINDS = ['instrumental', 'vocals'] as const;

/**
 * Two stems slaved to the main element, mixed through the player's own AudioContext: as elements,
 * or as decoded buffers when `buffered` (webOS: a second playing media element preempts the first).
 */
export class StemMix {
  private stems: Record<'instrumental' | 'vocals', Stem> | null = null;
  private bufs: Record<'instrumental' | 'vocals', BufferedStem> | null = null;
  private generation = 0;
  private decoding = false;
  private startedAt = 0;
  private offset = 0;
  private rate = 1;
  /** An aligned start is waiting for the main clock's next step; `startToken` cancels it. */
  private pending = false;
  private startToken = 0;
  private fileId: number | null = null;
  private ready = false;

  constructor(
    private readonly context: () => AudioContext | null,
    private readonly url: (fileId: number, kind: StemKind) => string,
    private readonly onReady: () => void,
    private readonly onFailed: () => void = () => undefined,
    private readonly buffered = false,
  ) {}

  /** True once both stems can play: the main element stays audible until then. */
  get loaded(): boolean {
    return this.ready;
  }

  /** The file whose stems are loaded or loading. */
  get file(): number | null {
    return this.fileId;
  }

  /** False when Web Audio is unavailable. */
  load(fileId: number): boolean {
    if (this.fileId === fileId) return true;
    if (this.buffered) return this.loadBuffered(fileId);
    const stems = this.build();
    if (!stems) return false;
    this.fileId = fileId;
    this.ready = false;
    for (const kind of KINDS) {
      stems[kind].el.src = this.url(fileId, kind);
      stems[kind].el.load();
    }
    return true;
  }

  clear(): void {
    this.generation++;
    this.decoding = false;
    this.fileId = null;
    this.ready = false;
    if (this.bufs) {
      this.stopSources();
      for (const k of KINDS) this.bufs[k].buffer = null;
    }
    if (!this.stems) return;
    for (const { el } of Object.values(this.stems)) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /** `scale` carries the player's ReplayGain and ducking, which the main element's own node applies otherwise. */
  setGains(g: MixGains, scale: number): void {
    const nodes = this.stems ?? this.bufs;
    if (!nodes) return;
    nodes.instrumental.gain.gain.value = g.instrumental * scale;
    nodes.vocals.gain.gain.value = g.vocals * scale;
  }

  /** Buffered mode only: fetches and decodes both stems, once per file; the sound switches when `onReady` fires. */
  decode(): void {
    const ctx = this.context();
    const bufs = this.bufs;
    const fileId = this.fileId;
    if (!ctx || !bufs || fileId === null || this.ready || this.decoding) return;
    this.decoding = true;
    const generation = this.generation;
    const fetchStem = async (kind: (typeof KINDS)[number]) => {
      const res = await fetch(this.url(fileId, kind));
      if (!res.ok) throw new Error(`stem ${kind}: ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    };
    Promise.all(KINDS.map(fetchStem)).then(
      ([instrumental, vocals]) => {
        if (generation !== this.generation) return;
        bufs.instrumental.buffer = instrumental;
        bufs.vocals.buffer = vocals;
        this.decoding = false;
        this.ready = true;
        this.onReady();
      },
      () => {
        if (generation !== this.generation) return;
        this.decoding = false;
        this.onFailed();
      },
    );
  }

  /** Follows the main element's state and corrects drift; called from its media events. */
  sync(main: HTMLAudioElement | null): void {
    if (this.buffered) return this.syncBuffered(main);
    if (!this.stems || this.fileId === null) return;
    const run = !!main && !main.paused && main.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    for (const { el } of Object.values(this.stems)) {
      if (!main) return el.pause();
      el.playbackRate = main.playbackRate;
      if (!run) {
        el.pause();
        if (needsReseek(main.currentTime, el.currentTime)) el.currentTime = main.currentTime;
      } else if (el.paused || needsReseek(main.currentTime, el.currentTime)) {
        el.currentTime = main.currentTime;
        if (el.paused) void el.play().catch(() => undefined);
      }
    }
  }

  private loadBuffered(fileId: number): boolean {
    if (!this.buildBuffered()) return false;
    this.generation++;
    this.decoding = false;
    this.stopSources();
    for (const k of KINDS) this.bufs![k].buffer = null;
    this.fileId = fileId;
    this.ready = false;
    return true;
  }

  private syncBuffered(main: HTMLAudioElement | null): void {
    const ctx = this.context();
    if (!ctx || !this.bufs || !this.ready) return;
    if (!main || main.paused || main.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return this.stopSources();
    const playing = this.bufs.instrumental.source !== null;
    if (!playing && this.pending) return;
    const expected = this.offset + (ctx.currentTime - this.startedAt) * this.rate;
    if (playing && Math.abs(main.currentTime - expected) <= BUFFERED_DRIFT_S) {
      if (this.rate !== main.playbackRate) {
        // rebase so the elapsed time before the change keeps its old rate
        this.offset = expected;
        this.startedAt = ctx.currentTime;
        this.rate = main.playbackRate;
        for (const k of KINDS) this.bufs[k].source!.playbackRate.value = this.rate;
      }
      return;
    }
    this.stopSources();
    this.startOnStep(main, ctx);
  }

  /** Starts on the main clock's next step, which is fresh, rather than on a reading up to a step stale. */
  private startOnStep(main: HTMLAudioElement, ctx: AudioContext): void {
    this.pending = true;
    const token = ++this.startToken;
    const seen = main.currentTime;
    const since = performance.now();
    const poll = () => {
      if (token !== this.startToken || !this.bufs) return;
      if (main.currentTime === seen && performance.now() - since < 300) return void requestAnimationFrame(poll);
      this.pending = false;
      this.startSources(main, ctx);
    };
    requestAnimationFrame(poll);
  }

  private startSources(main: HTMLAudioElement, ctx: AudioContext): void {
    if (!this.bufs) return;
    this.offset = main.currentTime;
    this.startedAt = ctx.currentTime;
    this.rate = main.playbackRate;
    for (const k of KINDS) {
      const stem = this.bufs[k];
      const source = ctx.createBufferSource();
      source.buffer = stem.buffer;
      source.playbackRate.value = this.rate;
      source.connect(stem.gain);
      source.start(0, this.offset);
      stem.source = source;
    }
  }

  private stopSources(): void {
    this.pending = false;
    this.startToken++;
    if (!this.bufs) return;
    for (const k of KINDS) {
      const stem = this.bufs[k];
      if (!stem.source) continue;
      try {
        stem.source.stop();
      } catch {
        // already stopped
      }
      stem.source.disconnect();
      stem.source = null;
    }
  }

  private checkReady(): void {
    if (this.ready || this.fileId === null || !this.stems) return;
    if (Object.values(this.stems).some(({ el }) => el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) return;
    this.ready = true;
    this.onReady();
  }

  private buildBuffered() {
    if (this.bufs) return this.bufs;
    const ctx = this.context();
    if (!ctx) return null;
    try {
      const make = (): BufferedStem => {
        const gain = ctx.createGain();
        gain.gain.value = 0;
        gain.connect(ctx.destination);
        return { buffer: null, gain, source: null };
      };
      return (this.bufs = { instrumental: make(), vocals: make() });
    } catch {
      return null;
    }
  }

  private build() {
    if (this.stems) return this.stems;
    const ctx = this.context();
    if (!ctx) return null;
    const make = (): Stem => {
      const el = new Audio();
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.preservesPitch = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      ctx.createMediaElementSource(el).connect(gain).connect(ctx.destination);
      el.addEventListener('canplay', () => this.checkReady());
      el.addEventListener('error', () => this.fileId !== null && el.getAttribute('src') && this.onFailed());
      return { el, gain };
    };
    try {
      return (this.stems = { instrumental: make(), vocals: make() });
    } catch {
      return null;
    }
  }
}
