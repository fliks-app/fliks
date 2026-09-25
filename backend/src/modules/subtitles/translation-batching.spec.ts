import {
  BATCH_SIZE,
  MAX_OUTPUT_TOKENS,
  MIN_TOKENS_PER_REQUEST,
  TranslationLimits,
  TranslationPayloadTooLargeError,
  translateWithBatching,
} from './translation-core';

const SYSTEM = 'x'.repeat(800); // ~200 tokens, close to the real instruction

function unlimited(): TranslationLimits {
  return {
    maxTokensPerRequest: 0,
    tokensPerMinute: 0,
    key: 'test',
    outputCeiling: MAX_OUTPUT_TOKENS,
    batchCeiling: BATCH_SIZE,
  };
}

describe('translateWithBatching token budget', () => {
  it('reserves an output budget scaled to the batch, never a flat maximum', async () => {
    const reservations: number[] = [];
    const out = await translateWithBatching(
      ['a', 'b', 'c'],
      async (batch, maxOutputTokens) => {
        reservations.push(maxOutputTokens);
        return batch.map((t) => `${t}!`);
      },
      unlimited(),
      SYSTEM,
    );
    expect(out).toEqual(['a!', 'b!', 'c!']);
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toBeLessThan(MAX_OUTPUT_TOKENS);
  });

  it('fills a batch up to the engine ceiling, so one request buys more of a file', async () => {
    const texts = Array.from({ length: 900 }, () => 'y'.repeat(200));
    const sizes: number[] = [];
    await translateWithBatching(
      texts,
      async (batch) => {
        sizes.push(batch.length);
        return batch;
      },
      { ...unlimited(), outputCeiling: 65_536, batchCeiling: 500 },
      SYSTEM,
    );
    // The cue ceiling binds before the token one: 500 per request, not 150.
    expect(sizes).toEqual([500, 400]);
  });

  it('keeps prompt + reservation under maxTokensPerRequest', async () => {
    const texts = Array.from({ length: 200 }, () => 'y'.repeat(400)); // 100 tokens each
    const limits: TranslationLimits = {
      maxTokensPerRequest: 6000,
      tokensPerMinute: 0,
      key: 'budget',
      outputCeiling: MAX_OUTPUT_TOKENS,
      batchCeiling: BATCH_SIZE,
    };
    const sizes: number[] = [];
    await translateWithBatching(
      texts,
      async (batch, maxOutputTokens) => {
        const prompt = 200 + batch.length * 104;
        expect(prompt + maxOutputTokens).toBeLessThanOrEqual(
          limits.maxTokensPerRequest,
        );
        sizes.push(batch.length);
        return batch;
      },
      limits,
      SYSTEM,
    );
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(BATCH_SIZE);
  });

  it('splits a batch the engine rejected as too large', async () => {
    const seen: number[] = [];
    const out = await translateWithBatching(
      ['a', 'b', 'c', 'd'],
      async (batch) => {
        seen.push(batch.length);
        if (batch.length > 1)
          throw new TranslationPayloadTooLargeError('too large');
        return batch.map((t) => `${t}!`);
      },
      unlimited(),
      SYSTEM,
    );
    expect(out).toEqual(['a!', 'b!', 'c!', 'd!']);
    expect(seen).toEqual([4, 2, 1, 1, 2, 1, 1]);
  });

  it('keeps source text for a single cue the engine rejects, instead of failing the whole run', async () => {
    const out = await translateWithBatching(
      ['a', 'b', 'c', 'd'],
      async (batch) => {
        if (batch.includes('c'))
          throw new TranslationPayloadTooLargeError('truncated');
        return batch.map((t) => `${t}!`);
      },
      unlimited(),
      SYSTEM,
    );
    expect(out).toEqual(['a!', 'b!', 'c', 'd!']);
  });

  it('fails the run when every cue is rejected as too large, instead of reporting an untranslated file as done', async () => {
    await expect(
      translateWithBatching(
        ['hello', 'world', 'goodbye'],
        async () => {
          throw new TranslationPayloadTooLargeError('always too large');
        },
        unlimited(),
        SYSTEM,
      ),
    ).rejects.toThrow('always too large');
  });

  it('reports progress for each split half, not just whole batches', async () => {
    const seen: number[] = [];
    await translateWithBatching(
      ['a', 'b', 'c', 'd'],
      async (batch) => {
        if (batch.length > 2)
          throw new TranslationPayloadTooLargeError('too large');
        return batch;
      },
      unlimited(),
      SYSTEM,
      (done, total) => {
        expect(total).toBe(4);
        seen.push(done);
      },
    );
    expect(seen).toEqual([2, 4]);
  });

  it('shrinks later batches to what the endpoint proved it accepts', async () => {
    const sizes: number[] = [];
    const out = await translateWithBatching(
      Array.from({ length: 800 }, (_, i) => `cue ${i}`),
      async (batch) => {
        sizes.push(batch.length);
        // Stands in for an endpoint that cuts anything over 100 cues.
        if (batch.length > 100) throw new TranslationPayloadTooLargeError('truncated');
        return batch;
      },
      { ...unlimited(), batchCeiling: 400 },
      SYSTEM,
    );
    expect(out).toHaveLength(800);
    // 400 is cut, so are both halves of the split already committed to, and from
    // then on every top-level batch starts under the limit instead of finding it
    // again. Without the shrink the second 400 would repeat the whole descent.
    expect(sizes.filter((n) => n > 100)).toEqual([400, 200, 200]);
  });

  it('clamps a maxTokensPerRequest too small for the system prompt instead of forcing one cue per batch', async () => {
    const bigSystem = 'x'.repeat(900); // ~225 tokens
    const texts = Array.from({ length: 6 }, (_, i) => `cue ${i}`);
    const sizes: number[] = [];
    await translateWithBatching(
      texts,
      async (batch) => {
        sizes.push(batch.length);
        return batch;
      },
      { ...unlimited(), maxTokensPerRequest: 100 },
      bigSystem,
    );
    expect(Math.max(...sizes)).toBeGreaterThan(1);
  });

  it('leaves a generous maxTokensPerRequest untouched', async () => {
    const sizes: number[] = [];
    await translateWithBatching(
      ['a', 'b'],
      async (batch) => {
        sizes.push(batch.length);
        return batch;
      },
      { ...unlimited(), maxTokensPerRequest: MIN_TOKENS_PER_REQUEST * 4 },
      SYSTEM,
    );
    expect(sizes).toEqual([2]);
  });

  it('clamps a zero batchCeiling instead of spinning forever', async () => {
    const out = await translateWithBatching(
      ['a', 'b'],
      async (batch) => batch.map((t) => `${t}!`),
      { ...unlimited(), batchCeiling: 0 },
      SYSTEM,
    );
    expect(out).toEqual(['a!', 'b!']);
  }, 10_000);

  it('propagates a non-size failure instead of splitting', async () => {
    await expect(
      translateWithBatching(
        ['a', 'b'],
        async () => {
          throw new Error('engine down');
        },
        unlimited(),
        SYSTEM,
      ),
    ).rejects.toThrow('engine down');
  });

  it('keeps one bad cue from collapsing every later batch to size 1', async () => {
    const BAD_INDEX = 700;
    const texts = Array.from({ length: 1500 }, (_, i) => `cue ${i}`);
    let calls = 0;
    const out = await translateWithBatching(
      texts,
      async (batch) => {
        calls++;
        // The bad cue never maps back, whatever else shares its batch:
        // a formatting quirk, not a size problem, so the engine never throws.
        if (batch.includes(texts[BAD_INDEX])) return null;
        return batch;
      },
      { ...unlimited(), batchCeiling: 150 },
      SYSTEM,
    );
    expect(out[BAD_INDEX]).toBe(texts[BAD_INDEX]); // kept as source, never translated
    expect(out.filter((_, i) => i !== BAD_INDEX)).toEqual(
      texts.filter((_, i) => i !== BAD_INDEX),
    );
    // Isolating the bad cue costs a handful of splits; a sticky ceiling would
    // instead force every remaining batch in the 1500-cue run down to size 1.
    expect(calls).toBeLessThan(50);
  });

  it('aborts instead of grinding through one request per cue when nothing maps back', async () => {
    await expect(
      translateWithBatching(
        Array.from({ length: 500 }, (_, i) => `cue ${i}`),
        async () => null,
        { ...unlimited(), batchCeiling: 150 },
        SYSTEM,
      ),
    ).rejects.toThrow(/consecutive cues failed to map back/);
  });

  it('paces requests against tokensPerMinute', async () => {
    jest.useFakeTimers();
    try {
      const limits: TranslationLimits = {
        maxTokensPerRequest: 0,
        tokensPerMinute: 900,
        key: `pace-${Date.now()}`,
        outputCeiling: MAX_OUTPUT_TOKENS,
        // Forces one cue per request, independent of the token-budget math, so
        // the pacing itself is what's under test here.
        batchCeiling: 1,
      };
      const starts: number[] = [];
      const texts = Array.from({ length: 6 }, () => 'z'.repeat(400));
      const run = translateWithBatching(
        texts,
        async (batch) => {
          starts.push(Date.now());
          return batch;
        },
        limits,
        'short',
      );
      await jest.advanceTimersByTimeAsync(180_000);
      await run;
      expect(starts.length).toBeGreaterThan(1);
      expect(starts[starts.length - 1] - starts[0]).toBeGreaterThanOrEqual(
        60_000,
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
