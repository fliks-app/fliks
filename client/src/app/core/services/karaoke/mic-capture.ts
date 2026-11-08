import { detectPitch } from './pitch-detect';
import type { PitchFrame } from './karaoke-score';

export const WINDOW = 2048;

/** Slides 1024-sample blocks through a 2048-sample window and reads its pitch. */
export class PitchWindow {
  private readonly win = new Float32Array(WINDOW);
  private filled = 0;

  push(block: Float32Array, sampleRate: number): number | null {
    this.win.copyWithin(0, block.length);
    this.win.set(block.subarray(Math.max(0, block.length - WINDOW)), WINDOW - Math.min(block.length, WINDOW));
    this.filled = Math.min(WINDOW, this.filled + block.length);
    return this.filled < WINDOW ? null : (detectPitch(this.win, sampleRate)?.midi ?? null);
  }
}

/** The phone's microphone as pitch frames: no echo cancelling, noise suppression or auto gain, which would bend the voice. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;

  /** `now` is the clock the frames are stamped with: host media time in ms. */
  async start(onFrame: (f: PitchFrame) => void, now: () => number): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
      await ctx.audioWorklet.addModule(new URL('karaoke-worklet.js', document.baseURI).href);
      const node = new AudioWorkletNode(ctx, 'karaoke-capture', { numberOfOutputs: 0 });
      const win = new PitchWindow();
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => onFrame({ t: now(), midi: win.push(ev.data, ctx.sampleRate) });
      ctx.createMediaStreamSource(this.stream).connect(node);
      await ctx.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
