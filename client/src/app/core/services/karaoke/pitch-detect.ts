export interface Pitch {
  midi: number;
  /** 0..1, higher is a cleaner periodic signal. */
  clarity: number;
}

const MIN_HZ = 70;
const MAX_HZ = 1000;
const THRESHOLD = 0.15;
const MIN_RMS = 0.01;

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** YIN pitch of one mono frame, or null when it is silent or unvoiced. */
export function detectPitch(buf: Float32Array, sampleRate: number): Pitch | null {
  const half = buf.length >> 1;
  let energy = 0;
  for (let i = 0; i < buf.length; i++) energy += buf[i] * buf[i];
  if (Math.sqrt(energy / buf.length) < MIN_RMS) return null;
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxTau = Math.min(half - 1, Math.floor(sampleRate / MIN_HZ));
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) {
      const x = buf[i] - buf[i + tau];
      sum += x * x;
    }
    d[tau] = sum;
  }
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau];
    d[tau] = running === 0 ? 1 : (d[tau] * tau) / running;
  }
  let tau = minTau;
  while (tau <= maxTau && d[tau] >= THRESHOLD) tau++;
  if (tau > maxTau) return null;
  while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++;
  const a = d[tau - 1] ?? d[tau];
  const c = d[tau + 1] ?? d[tau];
  const denom = 2 * (2 * d[tau] - a - c);
  const shift = denom === 0 ? 0 : (a - c) / denom;
  return { midi: hzToMidi(sampleRate / (tau + shift)), clarity: 1 - d[tau] };
}

const SMOOTH_FRAMES = 5;
const MIN_VOICED = 3;

/** Steadies the mic pitch: a frame moves to the octave of the last output (scoring and the lane ignore
 *  octaves), then the median of the last five; under three voiced among them is silence. */
export class PitchSmoother {
  private readonly recent: (number | null)[] = [];
  private last: number | null = null;

  push(midi: number | null): number | null {
    const m = midi === null || this.last === null ? midi : midi + 12 * Math.round((this.last - midi) / 12);
    this.recent.push(m);
    if (this.recent.length > SMOOTH_FRAMES) this.recent.shift();
    const voiced = this.recent.filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (!voiced.length) this.last = null;
    if (m === null || voiced.length < MIN_VOICED) return null;
    this.last = voiced[voiced.length >> 1];
    return this.last;
  }
}
