import { OpenSubtitlesProvider } from './opensubtitles.provider';
import { rateLimitedFetch } from './rate-limiter';

jest.mock('./rate-limiter', () => ({
  isRateLimited: jest.fn().mockReturnValue(false),
  rateLimitedFetch: jest.fn(),
  markRateLimited: jest.fn(),
}));

const mockedFetch = rateLimitedFetch as jest.Mock;

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function provider() {
  return new OpenSubtitlesProvider({ username: '', password: '' });
}

describe('OpenSubtitlesProvider.search', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(jsonResponse({ data: [] }));
  });

  it('sends the title as a free-text query when hash and ids are absent', async () => {
    await provider().search({ title: 'Quiet Harbour', year: 2020, language: 'en' });

    const url = new URL(mockedFetch.mock.calls[0][1] as string);
    expect(url.searchParams.get('query')).toBe('Quiet Harbour');
    expect(url.searchParams.get('year')).toBe('2020');
  });

  it('does not send the title when a tmdbId is present', async () => {
    await provider().search({ title: 'Quiet Harbour', tmdbId: 42, language: 'en' });

    const url = new URL(mockedFetch.mock.calls[0][1] as string);
    expect(url.searchParams.has('query')).toBe(false);
    expect(url.searchParams.get('tmdb_id')).toBe('42');
  });
});
