import { SubdlProvider } from './subdl.provider';
import { rateLimitedFetch } from './rate-limiter';

jest.mock('./rate-limiter', () => ({
  isRateLimited: jest.fn().mockReturnValue(false),
  rateLimitedFetch: jest.fn(),
}));

const mockedFetch = rateLimitedFetch as jest.Mock;

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function provider() {
  return new SubdlProvider({ apiKey: 'test-key' });
}

describe('SubdlProvider.search', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(jsonResponse({ status: true, subtitles: [] }));
  });

  it('sends the title as film_name when hash and ids are absent', async () => {
    await provider().search({ title: 'Quiet Harbour', year: 2020, language: 'en' });

    const url = new URL(mockedFetch.mock.calls[0][1] as string);
    expect(url.searchParams.get('film_name')).toBe('Quiet Harbour');
    expect(url.searchParams.get('year')).toBe('2020');
  });

  it('does not send the title when a tmdbId is present', async () => {
    await provider().search({ title: 'Quiet Harbour', tmdbId: 42, language: 'en' });

    const url = new URL(mockedFetch.mock.calls[0][1] as string);
    expect(url.searchParams.has('film_name')).toBe(false);
    expect(url.searchParams.get('tmdb_id')).toBe('42');
  });
});
