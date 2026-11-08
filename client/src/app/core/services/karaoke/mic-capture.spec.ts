import { PitchWindow } from './mic-capture';

const sine = (hz: number, n: number, at = 0, rate = 44100) => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * (i + at)) / rate));

describe('PitchWindow', () => {
  it('waits for a full window, then reads the pitch of the blocks', () => {
    const w = new PitchWindow();
    expect(w.push(sine(440, 1024), 44100)).toBeNull();
    expect(w.push(sine(440, 1024, 1024), 44100)).toBeCloseTo(69, 0);
  });

  it('gives null for silence', () => {
    const w = new PitchWindow();
    w.push(new Float32Array(1024), 44100);
    expect(w.push(new Float32Array(1024), 44100)).toBeNull();
  });
});
