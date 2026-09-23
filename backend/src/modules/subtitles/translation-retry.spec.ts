import {
  TranslationPayloadTooLargeError,
  TranslationRateLimitError,
  postWithRetry,
} from './translation-core';

const GROQ_TPM_413 = JSON.stringify({
  error: {
    message:
      'Request too large for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Requested 8716',
    type: 'tokens',
    code: 'rate_limit_exceeded',
  },
});
const CONTEXT_413 = JSON.stringify({
  error: { message: 'Request too large: maximum context length is 4096 tokens' },
});

function reply(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

describe('postWithRetry', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.useFakeTimers();
  });
  afterEach(() => jest.useRealTimers());

  /** Runs `p` while draining the retry sleeps so the test doesn't wait for real. */
  async function settle<T>(p: Promise<T>): Promise<T> {
    const caught = p.catch((e: unknown) => e as T);
    await jest.advanceTimersByTimeAsync(300_000);
    return caught;
  }

  it('waits and retries a 413 that is really a spent per-minute quota', async () => {
    fetchMock
      .mockResolvedValueOnce(reply(413, GROQ_TPM_413))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    const res = await settle(postWithRetry('http://x', {}, 'Groq'));
    expect((res as Response).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up on a quota 413 as a rate limit, never as a payload error', async () => {
    fetchMock.mockResolvedValue(reply(413, GROQ_TPM_413));
    const err = await settle(postWithRetry('http://x', {}, 'Groq'));
    expect(err).toBeInstanceOf(TranslationRateLimitError);
  });

  it('gives up at once on a per-day quota rather than spending the rest of it', async () => {
    const PER_DAY = JSON.stringify({
      error: {
        code: 429,
        message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      },
    });
    fetchMock.mockResolvedValue(reply(429, PER_DAY));
    const err = await settle(postWithRetry('http://x', {}, 'Gemini'));
    expect(err).toBeInstanceOf(TranslationRateLimitError);
    expect(String(err)).toContain('daily');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a context-length 413 as too large so the batch splits', async () => {
    fetchMock.mockResolvedValue(reply(413, CONTEXT_413));
    const err = await settle(postWithRetry('http://x', {}, 'Groq'));
    expect(err).toBeInstanceOf(TranslationPayloadTooLargeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
