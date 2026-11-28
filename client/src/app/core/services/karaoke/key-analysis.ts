import type { KaraokeAnalysis, KaraokeKey } from '../api/karaoke.models';
import { readStored, writeStored } from '../../utils/local-flag';
import type { LaneRange } from './pitch-lane';

/** Under this correlation the key is a guess, not an estimate. */
export const SURE_KEY = 0.5;
export const SURE_TEMPO = 0.5;
const VOICE_KEY = 'karaoke.voice';
/** About a minute of voiced singing before the range is trusted. */
const MIN_FRAMES = 3000;
const SAVE_EVERY = 500;

const pc = (n: number) => ((n % 12) + 12) % 12;

/** `names` are the twelve tonics of the key's mode, from C. */
export function keyName(k: KaraokeKey, shift: number, names: { major: string[]; minor: string[] }): string {
  return names[k.mode][pc(k.tonic + shift)] ?? '';
}

export function noteName(midi: number, names: string[]): string {
  const m = Math.round(midi);
  return `${names[pc(m)] ?? ''}${Math.floor(m / 12) - 1}`;
}

/** Whether the shifted song sits in the voice, an octave away included since scoring folds octaves; null with no voice range. */
export function fitsVoice(a: KaraokeAnalysis, shift: number, voice: LaneRange | null): boolean | null {
  if (!voice) return null;
  const [lo, hi] = [Math.round(a.lowMidi) + shift, Math.round(a.highMidi) + shift];
  return [-12, 0, 12].some((o) => lo + o >= voice.lo - 1 && hi + o <= voice.hi + 1);
}

/** This device's sung pitches per semitone, kept across songs; the 5th to 95th percentile is the voice's range. */
export class VoiceRange {
  private readonly counts = load();
  private unsaved = 0;

  /** True when this frame saved the histogram. */
  add(midi: number): boolean {
    const m = Math.round(midi);
    if (!(m >= 0 && m < 128)) return false;
    this.counts[m]++;
    if (++this.unsaved < SAVE_EVERY) return false;
    this.save();
    return true;
  }

  save(): void {
    if (!this.unsaved) return;
    this.unsaved = 0;
    writeStored(VOICE_KEY, JSON.stringify(this.counts));
  }

  range(): LaneRange | null {
    const total = this.counts.reduce((a, b) => a + b, 0);
    return total < MIN_FRAMES ? null : { lo: this.at(total * 0.05), hi: this.at(total * 0.95) };
  }

  private at(target: number): number {
    let sum = 0;
    return Math.max(0, this.counts.findIndex((c) => (sum += c) >= target));
  }
}

function load(): number[] {
  try {
    const v = JSON.parse(readStored(VOICE_KEY) ?? 'null') as unknown;
    if (Array.isArray(v) && v.length === 128 && v.every((n) => Number.isFinite(n) && n >= 0)) return v as number[];
  } catch {
    // corrupt value: start over
  }
  return new Array<number>(128).fill(0);
}
