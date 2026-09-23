import { SupersubtitlesProvider } from './supersubtitles.provider';
import { rateLimitedFetch } from './rate-limiter';

jest.mock('./rate-limiter', () => ({
  isRateLimited: jest.fn().mockReturnValue(false),
  rateLimitedFetch: jest.fn(),
}));

const mockedFetch = rateLimitedFetch as jest.Mock;

/** Bodies below are what feliratok.eu actually answered, all of them HTTP 200. */
const textResponse = (body: string): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  }) as unknown as Response;

const HIT = JSON.stringify([{ name: 'Breaking Bad (2008)', ID: '252' }]);
const MISS = JSON.stringify([{ name: 'Nincs találat', ID: '-100x' }]);
const EPISODE = JSON.stringify([
  {
    language: 'Magyar',
    nev: 'Placeholder (Season 1) (720p-CtrlHD)',
    fnev: 'placeholder.s1.zip',
    felirat: '1295179297',
    evad: '1',
    ep: '1',
    feltolto: 'someone',
    evadpakk: '0',
  },
]);

const params = {
  title: 'Placeholder',
  season: 1,
  episode: 1,
  mediaType: 'series',
} as never;
const search = () => new SupersubtitlesProvider({}).search(params);

describe('SupersubtitlesProvider episode search', () => {
  beforeEach(() => mockedFetch.mockReset());

  it('maps a real hit', async () => {
    mockedFetch
      .mockResolvedValueOnce(textResponse(HIT))
      .mockResolvedValueOnce(textResponse(EPISODE));

    const [first] = await search();
    expect(first).toMatchObject({
      providerFileId: '1295179297',
      language: 'hu',
      providerType: 'supersubtitles',
    });
  });

  it('stops at the no-match sentinel instead of querying a bad series id', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(MISS));

    await expect(search()).resolves.toEqual([]);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty body, which an unknown episode returns', ''],
    ['a plain-text message, which a bad series id returns', 'Nincs SorozatID!'],
    ['a literal null', 'null'],
  ])('survives %s', async (_label, body) => {
    mockedFetch
      .mockResolvedValueOnce(textResponse(HIT))
      .mockResolvedValueOnce(textResponse(body));

    await expect(search()).resolves.toEqual([]);
  });

  it('skips an entry carrying no subtitle id', async () => {
    mockedFetch
      .mockResolvedValueOnce(textResponse(HIT))
      .mockResolvedValueOnce(
        textResponse(JSON.stringify({ a: null, b: { felirat: '' } })),
      );

    await expect(search()).resolves.toEqual([]);
  });
});
