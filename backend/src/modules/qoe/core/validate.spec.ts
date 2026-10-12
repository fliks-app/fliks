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

describe('parseEvents', () => {
  it('filters invalid events and caps the batch', () => {
    const many = Array.from({ length: 80 }, () => ({ type: 'stall', at: 1 }));
    expect(parseEvents(many)).toHaveLength(MAX_EVENTS_PER_REQUEST);
    expect(
      parseEvents([
        { type: 'bogus', at: 1 },
        { type: 'stall' },
        { type: 'stall', at: -3 },
        'x',
      ]),
    ).toEqual([]);
    expect(parseEvents({})).toEqual([]);
  });

  it('keeps typed fields only', () => {
    expect(
      parseEvents([
        {
          type: 'error',
          at: 5,
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
        at: 5,
        position: null,
        code: 3016,
        message: 'm'.repeat(300),
        category: 'decode',
      },
    ]);
  });
});
