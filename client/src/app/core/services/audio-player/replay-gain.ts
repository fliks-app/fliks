export type ReplayGainMode = 'off' | 'track' | 'album';

export const REPLAY_GAINS: ReplayGainMode[] = ['off', 'track', 'album'];
export const PREAMP_STEPS = [-6, -3, 0, 3, 6];

interface Gains {
  gain: number | null;
  peak: number | null;
  albumGain: number | null;
  albumPeak: number | null;
}

/** Linear factor for a track: album gain only when the queue is one album, never past full scale given the peak. */
export function replayGainFactor(mode: ReplayGainMode, preampDb: number, t: Gains, oneAlbum: boolean): number {
  if (mode === 'off') return 1;
  const album = mode === 'album' && oneAlbum && t.albumGain != null;
  const gain = album ? t.albumGain : t.gain;
  if (gain == null) return 1;
  const peak = album ? t.albumPeak : t.peak;
  const factor = 10 ** ((gain + preampDb) / 20);
  return peak && peak > 0 && factor * peak > 1 ? 1 / peak : factor;
}
