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

/** Two rows copied from a live search page, trimmed of the cells the parser
 *  ignores. The download id is the LAST parameter, after the filename. */
const MOVIE_PAGE = `
<table>
<tr>
  <td align="center" class="lang"><small>Angol</small></td>
  <td align="left"><div class="magyar">Eredet</div>
  <div class="eredeti">Inception (2010) (NF.WEBRip)</div></td>
  <td align="center"><a href="/index.php?action=letolt&fnev=Inception.2010.NF.WEB-DL.en.srt&felirat=1756650761">
  <img src="img/download.png" /></a></td>
</tr>
<tr>
  <td align="center" class="lang"><small>Magyar</small></td>
  <td align="left"><div class="magyar">Eredet</div>
  <div class="eredeti">Inception (2010) (WEBRip.1080p-HiDt)</div></td>
  <td align="center"><a href="/index.php?action=letolt&fnev=Inception.2010.hu.srt&felirat=1728736777">
  <img src="img/download.png" /></a></td>
</tr>
</table>`;

describe('SupersubtitlesProvider movie search', () => {
  beforeEach(() => mockedFetch.mockReset());

  const movie = { title: 'Inception', year: 2010, mediaType: 'movie' } as never;

  it('reads the id, the release and the language of each row', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(MOVIE_PAGE));

    const out = await new SupersubtitlesProvider({}).search(movie);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      providerFileId: '1756650761',
      language: 'en',
      title: 'Inception (2010) (NF.WEBRip)',
    });
    expect(out[1]).toMatchObject({
      providerFileId: '1728736777',
      language: 'hu',
    });
  });

  it('does not read the Hungarian-title CSS class as a language', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(MOVIE_PAGE));

    const [english] = await new SupersubtitlesProvider({}).search(movie);

    expect(english.language).toBe('en');
  });

  it('filters on the requested language', async () => {
    mockedFetch.mockResolvedValueOnce(textResponse(MOVIE_PAGE));

    const out = await new SupersubtitlesProvider({}).search({
      ...(movie as object),
      language: 'en',
    } as never);

    expect(out.map((r) => r.providerFileId)).toEqual(['1756650761']);
  });

  it('returns nothing for a page with no download link', async () => {
    mockedFetch.mockResolvedValueOnce(
      textResponse('<table><tr><td>Nothing</td></tr></table>'),
    );

    await expect(new SupersubtitlesProvider({}).search(movie)).resolves.toEqual(
      [],
    );
  });
});
