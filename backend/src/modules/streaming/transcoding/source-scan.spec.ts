import { AdtsConfigWalker, aacConfigMayChange, type SourceScan } from './source-scan';

/** An ADTS frame: AAC LC unless `profile`, sampling index 3 (48 kHz), `channels`. */
function adts(channels: number, payload = 20, profile = 1, sampling = 3): Buffer {
  const length = 7 + payload;
  const b = Buffer.alloc(length, 0x5a);
  b[0] = 0xff;
  b[1] = 0xf1;
  b[2] = (profile << 6) | (sampling << 2) | (channels >> 2);
  b[3] = ((channels & 3) << 6) | ((length >> 11) & 3);
  b[4] = (length >> 3) & 0xff;
  b[5] = ((length & 7) << 5) | 0x1f;
  b[6] = 0xfc;
  return b;
}

const walk = (...chunks: Buffer[]) => {
  const w = new AdtsConfigWalker();
  chunks.forEach((c) => w.push(c));
  return w.changed;
};

describe('AdtsConfigWalker', () => {
  it('sees a channel configuration change, across chunk boundaries', () => {
    const stream = Buffer.concat([adts(2), adts(2), adts(6), adts(6)]);
    expect(walk(stream)).toBe(true);
    // Every split point, the header of the changed frame included.
    for (let cut = 1; cut < stream.length; cut += 5) {
      expect(walk(stream.subarray(0, cut), stream.subarray(cut))).toBe(true);
    }
  });

  it('sees a sample rate or profile change', () => {
    expect(walk(Buffer.concat([adts(2), adts(2, 20, 1, 4)]))).toBe(true);
    expect(walk(Buffer.concat([adts(2), adts(2, 20, 0)]))).toBe(true);
  });

  it('reports a steady stream as steady, whatever the frame sizes', () => {
    expect(walk(Buffer.concat([adts(2, 20), adts(2, 300), adts(2, 1)]))).toBe(false);
  });
});

describe('aacConfigMayChange', () => {
  const scan = (changes: Record<number, boolean>): SourceScan => ({
    keyframes: [],
    end: 10,
    audioConfigChanges: changes,
  });

  it('is unknown before a scan, and false where the container fixes the configuration', () => {
    expect(aacConfigMayChange(null, 1)).toBeUndefined();
    expect(aacConfigMayChange(scan({}), 1)).toBe(false);
    expect(aacConfigMayChange(scan({ 1: true, 2: false }), 1)).toBe(true);
    // As stored: JSON keys are strings.
    expect(aacConfigMayChange(JSON.parse(JSON.stringify(scan({ 2: true }))), 2)).toBe(true);
  });
});
