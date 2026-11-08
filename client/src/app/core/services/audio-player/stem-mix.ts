import type { StemKind } from '../api/karaoke.models';

export type StemMode = 'original' | 'guide' | 'instrumental';

export const GUIDE_VOCAL_LEVEL = 0.25;
export const DRIFT_TOLERANCE_S = 0.15;

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

/** Two stem elements slaved to the main element, mixed through the player's own AudioContext. */
export class StemMix {
  private stems: Record<'instrumental' | 'vocals', Stem> | null = null;
  private fileId: number | null = null;
  private ready = false;

  constructor(
    private readonly context: () => AudioContext | null,
    private readonly url: (fileId: number, kind: StemKind) => string,
    private readonly onReady: () => void,
    private readonly onFailed: () => void = () => undefined,
  ) {}

  /** True once both stems can play: the main element stays audible until then. */
  get loaded(): boolean {
    return this.ready;
  }

  /** False when Web Audio is unavailable. */
  load(fileId: number): boolean {
    if (this.fileId === fileId) return true;
    const stems = this.build();
    if (!stems) return false;
    this.fileId = fileId;
    this.ready = false;
    for (const kind of ['instrumental', 'vocals'] as const) {
      stems[kind].el.src = this.url(fileId, kind);
      stems[kind].el.load();
    }
    return true;
  }

  clear(): void {
    this.fileId = null;
    this.ready = false;
    if (!this.stems) return;
    for (const { el } of Object.values(this.stems)) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
  }

  /** `scale` carries the player's ReplayGain and ducking, which the main element's own node applies otherwise. */
  setGains(g: MixGains, scale: number): void {
    if (!this.stems) return;
    this.stems.instrumental.gain.gain.value = g.instrumental * scale;
    this.stems.vocals.gain.gain.value = g.vocals * scale;
  }

  /** Follows the main element's state and corrects drift; called from its media events. */
  sync(main: HTMLAudioElement | null): void {
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

  private checkReady(): void {
    if (this.ready || this.fileId === null || !this.stems) return;
    if (Object.values(this.stems).some(({ el }) => el.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)) return;
    this.ready = true;
    this.onReady();
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
