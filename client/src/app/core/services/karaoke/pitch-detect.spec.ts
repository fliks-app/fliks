import { detectPitch, hzToMidi } from './pitch-detect';

const sine = (hz: number, rate = 16000, n = 1024, amp = 0.5): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe('detectPitch', () => {
  it('finds A4 and an octave below within a quarter tone', () => {
    expect(detectPitch(sine(440), 16000)!.midi).toBeCloseTo(69, 0);
    expect(detectPitch(sine(220), 16000)!.midi).toBeCloseTo(57, 0);
  });
  it('is null for silence and noise-free quiet input', () => {
    expect(detectPitch(new Float32Array(1024), 16000)).toBeNull();
    expect(detectPitch(sine(440, 16000, 1024, 0.001), 16000)).toBeNull();
  });
  it('maps hz to midi', () => expect(hzToMidi(261.6256)).toBeCloseTo(60, 2));
});
