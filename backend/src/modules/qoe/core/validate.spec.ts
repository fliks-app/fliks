import { MAX_EVENTS_PER_REQUEST, parseEvents, parseSample } from './validate';

describe('parseSample', () => {
  it('keeps valid fields, nulls bad numbers, drops unknown fields', () => {
    const s = parseSample({
      engine: 'shaka',
      cmcd: true,
      droppedFrames: -1,
      decodedFrames: 100,
      bandwidthBps: Infinity,
      decoderName: 'x'.repeat(500),
      hwDecoder: 'yes',
      stallCount: 2,
      evil: 'x',
    });
    expect(s).toMatchObject({
      engine: 'shaka',
      cmcd: true,
      droppedFrames: null,
      decodedFrames: 100,
      bandwidthBps: null,
      hwDecoder: null,
      stallCount: 2,
      stallMs: 0,
    });
    expect(s?.decoderName).toHaveLength(128);
    expect(s).not.toHaveProperty('evil');
  });

  it('rejects an unknown engine or a non-object', () => {
    expect(parseSample({ engine: 'vlc' })).toBeNull();
    expect(parseSample('x')).toBeNull();
    expect(parseSample(null)).toBeNull();
  });
});

describe('parseSample integers', () => {
  it('rounds fractions and clamps values an int column cannot hold', () => {
    const s = parseSample({
      engine: 'mpv',
      width: 1919.6,
      height: 1e12,
      droppedFrames: 3.4,
      stallCount: 2 ** 40,
    });
    expect(s).toMatchObject({
      width: 1920,
      height: 2 ** 31 - 1,
      droppedFrames: 3,
      stallCount: 2 ** 31 - 1,
    });
  });
});

describe('parseEvents', () => {
  it('filters invalid events and caps the batch', () => {
    const many = Array.from({ length: 80 }, () => ({ type: 'stall', at: 1 }));
    expect(parseEvents(many)).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(parseEvents([{ type: 'bogus', at: 1 }, 'x'])).toEqual([]);
    expect(parseEvents({})).toEqual([]);
  });

  it('replaces an implausible client clock with the receive time', () => {
    const now = 1_700_000_000_000;
    const at = (v: unknown) => parseEvents([{ type: 'stall', at: v }], now)[0].at;
    expect(at(now - 3_600_000)).toBe(now - 3_600_000);
    expect(at(1)).toBe(now);
    expect(at(now + 2 * 86_400_000)).toBe(now);
    expect(at(undefined)).toBe(now);
  });

  it('keeps typed fields only', () => {
    expect(
      parseEvents([
        {
          type: 'error',
          at: Date.now(),
          position: 'x',
          code: 3016,
          message: 'm'.repeat(1000),
          category: 'decode',
          durationMs: -1,
          junk: 1,
        },
      ]),
    ).toEqual([
      {
        type: 'error',
        at: expect.any(Number),
        position: null,
        code: 3016,
        message: 'm'.repeat(300),
        category: 'decode',
      },
    ]);
  });
});
