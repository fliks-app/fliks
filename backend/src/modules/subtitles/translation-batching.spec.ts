import {
  BATCH_SIZE,
  MAX_OUTPUT_TOKENS,
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

  it('paces requests against tokensPerMinute', async () => {
    jest.useFakeTimers();
    try {
      const limits: TranslationLimits = {
        maxTokensPerRequest: 600,
        tokensPerMinute: 900,
        key: `pace-${Date.now()}`,
        outputCeiling: MAX_OUTPUT_TOKENS,
        batchCeiling: BATCH_SIZE,
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
