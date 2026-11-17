import type { PluginListenerHandle } from '@capacitor/core';
import { Capacitor } from '@capacitor/core';
import { KaraokeMic } from '../../plugins/karaoke-mic.plugin';
import { PitchSmoother, detectPitch } from './pitch-detect';
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

/** The phone's microphone as pitch frames; the browser path has no echo cancelling, noise suppression or auto gain, which would bend the voice. */
export class MicCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private native: PluginListenerHandle | null = null;

  /** `now` is the clock the frames are stamped with: host media time in ms. */
  async start(onFrame: (f: PitchFrame) => void, now: () => number): Promise<void> {
    if (Capacitor.getPlatform() === 'android') return this.startNative(onFrame, now);
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    try {
      const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
      await ctx.audioWorklet.addModule(new URL('karaoke-worklet.js', document.baseURI).href);
      const node = new AudioWorkletNode(ctx, 'karaoke-capture', { numberOfOutputs: 0 });
      const win = new PitchWindow();
      const smooth = new PitchSmoother();
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => onFrame({ t: now(), midi: smooth.push(win.push(ev.data, ctx.sampleRate)) });
      ctx.createMediaStreamSource(this.stream).connect(node);
      await ctx.resume();
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  /** The WebView's echo canceller would put Android in call mode, so the platform one runs natively. */
  private async startNative(onFrame: (f: PitchFrame) => void, now: () => number): Promise<void> {
    const win = new PitchWindow();
    const smooth = new PitchSmoother();
    let rate = 48000;
    this.native = await KaraokeMic.addListener('block', ({ data }) => {
      const pcm = new Int16Array(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)).buffer);
      onFrame({ t: now(), midi: smooth.push(win.push(Float32Array.from(pcm, (v) => v / 32768), rate)) });
    });
    try {
      rate = (await KaraokeMic.start()).sampleRate;
    } catch (err) {
      this.stop();
      throw (err as { message?: string }).message === 'denied' ? new DOMException('denied', 'NotAllowedError') : err;
    }
  }

  stop(): void {
    if (this.native) {
      void this.native.remove();
      void KaraokeMic.stop().catch(() => undefined);
      this.native = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
