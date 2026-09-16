import { parseM3u, deriveExternalId, isOnDemandUrl } from './m3u.parser';

describe('parseM3u', () => {
  it('reads the header guide url and the usual attributes', () => {
    const playlist = parseM3u(
      [
        '#EXTM3U x-tvg-url="http://provider/xmltv.php?u=a"',
        '#EXTINF:-1 tvg-id="C1.fr" tvg-name="One" tvg-logo="http://logo/1.png" tvg-chno="7" group-title="News",One FHD',
        'http://provider/live/u/p/101.ts',
      ].join('\n'),
    );

    expect(playlist.guideUrl).toBe('http://provider/xmltv.php?u=a');
    expect(playlist.guideUrls).toEqual(['http://provider/xmltv.php?u=a']);
    expect(playlist.entries).toHaveLength(1);
    expect(playlist.entries[0]).toMatchObject({
      externalId: '101',
      name: 'One FHD',
      url: 'http://provider/live/u/p/101.ts',
      logo: 'http://logo/1.png',
      groupName: 'News',
      number: 7,
      tvgId: 'C1.fr',
      shiftMinutes: 0,
      userAgent: null,
      referer: null,
    });
  });

  it('keeps every comma separated guide url from the header', () => {
    const playlist = parseM3u(
      '#EXTM3U x-tvg-url="http://a/xmltv.php,http://b/epg.xml"\n',
    );
    expect(playlist.guideUrls).toEqual(['http://a/xmltv.php', 'http://b/epg.xml']);
    expect(playlist.guideUrl).toBe('http://a/xmltv.php');
  });

  it('falls back to EXTGRP when no group-title is present', () => {
    const playlist = parseM3u(
      ['#EXTINF:-1,Two', '#EXTGRP:Sport', 'http://provider/2.ts'].join('\n'),
    );
    expect(playlist.entries[0].groupName).toBe('Sport');
  });

  it('keeps fractional tvg-shift in minutes', () => {
    const playlist = parseM3u(
      ['#EXTINF:-1 tvg-shift="-0.5",Three', 'http://provider/3.ts'].join('\n'),
    );
    expect(playlist.entries[0].shiftMinutes).toBe(-30);
  });

  it('skips unrecognised player directives and entries with no url', () => {
    const playlist = parseM3u(
      [
        '#EXTINF:-1,Four',
        '#EXTVLCOPT:some-other-option=1',
        'http://provider/4.ts',
        '#EXTINF:-1,Dangling',
      ].join('\n'),
    );
    expect(playlist.entries.map((e) => e.name)).toEqual(['Four']);
  });

  it('keeps the quality variants a shared tvg-id would have collapsed', () => {
    // A provider gives HD/FHD/SD the same tvg-id on purpose, so they share
    // programme data. They are still three separate streams to play.
    const playlist = parseM3u(
      [
        '#EXTINF:-1 tvg-id="one.fr",One HD',
        'http://provider/live/u/p/101.ts',
        '#EXTINF:-1 tvg-id="one.fr",One FHD',
        'http://provider/live/u/p/102.ts',
      ].join('\n'),
    );
    expect(playlist.entries).toHaveLength(2);
    expect(playlist.entries.map((e) => e.externalId)).toEqual(['101', '102']);
    expect(playlist.entries.every((e) => e.tvgId === 'one.fr')).toBe(true);
  });

  it('still drops a genuine duplicate, the same entry listed twice', () => {
    const playlist = parseM3u(
      [
        '#EXTINF:-1,A',
        'http://provider/live/u/p/101.ts',
        '#EXTINF:-1,A again',
        'http://provider/live/u/p/101.ts',
      ].join('\n'),
    );
    expect(playlist.entries).toHaveLength(1);
  });

  describe('per-entry header directives', () => {
    it.each([
      {
        label: 'EXTVLCOPT user agent and referrer (double r)',
        lines: [
          '#EXTINF:-1,A',
          '#EXTVLCOPT:http-user-agent=VLC/3.0.20 LibVLC/3.0.20',
          '#EXTVLCOPT:http-referrer=http://portal.example/',
          'http://provider/1.ts',
        ],
        userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
        referer: 'http://portal.example/',
      },
      {
        label: 'EXTVLCOPT referer (single r) spelling',
        lines: [
          '#EXTINF:-1,A',
          '#EXTVLCOPT:http-referer=http://portal.example/single',
          'http://provider/1.ts',
        ],
        userAgent: null,
        referer: 'http://portal.example/single',
      },
      {
        label: 'KODIPROP stream_headers with both keys',
        lines: [
          '#EXTINF:-1,A',
          '#KODIPROP:inputstream.adaptive.stream_headers=User-Agent=Kodi%2F20&Referer=http%3A%2F%2Fp.example%2F',
          'http://provider/1.ts',
        ],
        userAgent: 'Kodi/20',
        referer: 'http://p.example/',
      },
      {
        label: 'KODIPROP with only a referer header',
        lines: [
          '#EXTINF:-1,A',
          '#KODIPROP:inputstream.adaptive.stream_headers=Referer=http://p.example/',
          'http://provider/1.ts',
        ],
        userAgent: null,
        referer: 'http://p.example/',
      },
      {
        label: 'no header directives at all',
        lines: ['#EXTINF:-1,A', 'http://provider/1.ts'],
        userAgent: null,
        referer: null,
      },
    ])('$label', ({ lines, userAgent, referer }) => {
      const playlist = parseM3u(lines.join('\n'));
      expect(playlist.entries[0].userAgent).toBe(userAgent);
      expect(playlist.entries[0].referer).toBe(referer);
    });

    it('resets the carried headers between entries', () => {
      const playlist = parseM3u(
        [
          '#EXTINF:-1,A',
          '#EXTVLCOPT:http-user-agent=Custom/1.0',
          'http://provider/1.ts',
          '#EXTINF:-1,B',
          'http://provider/2.ts',
        ].join('\n'),
      );
      expect(playlist.entries[0].userAgent).toBe('Custom/1.0');
      expect(playlist.entries[1].userAgent).toBeNull();
    });
  });

  describe('#EXTM3U header account attributes', () => {
    it.each([
      { attrs: 'max-conn="2" billed-till="1893456000"', maxConnections: 2, expiresAt: new Date(1893456000 * 1000) },
      { attrs: 'max-conn="1" billed-till="2029-12-31"', maxConnections: 1, expiresAt: new Date('2029-12-31') },
      { attrs: '', maxConnections: null, expiresAt: null },
      { attrs: 'billed-till="not-a-date"', maxConnections: null, expiresAt: null },
      // A small integer is a day count, not an epoch, and must not be misread as 1970.
      { attrs: 'billed-till="30"', maxConnections: null, expiresAt: null },
    ])('$attrs', ({ attrs, maxConnections, expiresAt }) => {
      const playlist = parseM3u(`#EXTM3U ${attrs}\n#EXTINF:-1,A\nhttp://provider/1.ts\n`);
      expect(playlist.maxConnections).toBe(maxConnections);
      expect(playlist.expiresAt).toEqual(expiresAt);
    });
  });
});

describe('deriveExternalId', () => {
  it('ignores tvg-id, which names the guide rather than the stream', () => {
    expect(deriveExternalId({ 'tvg-id': 'X.fr' }, 'http://h/9.ts', 'X')).toBe('9');
  });

  it('falls back to the panel stream id, ignoring the extension and query', () => {
    expect(deriveExternalId({}, 'http://h:8080/live/u/p/4321.m3u8?x=1', 'X')).toBe(
      '4321',
    );
  });

  it('falls back to the url when it carries no usable id', () => {
    expect(deriveExternalId({}, 'http://h/', 'Canal + HD')).toBe('http://h/');
  });

  it('ignores a manifest name that every provider reuses', () => {
    // Two channels whose URLs both end in index.m3u8 must not share an id.
    expect(deriveExternalId({}, 'http://a/live/index.m3u8', 'One')).toBe(
      'http://a/live/index.m3u8',
    );
    expect(deriveExternalId({}, 'http://b/hls/master.m3u8', 'Two')).toBe(
      'http://b/hls/master.m3u8',
    );
  });
});

describe('isOnDemandUrl', () => {
  it.each([
    ['http://h/movie/u/p/1.mp4', true],
    ['http://h/series/u/p/1/2/3.mp4', true],
    ['http://h/MOVIE/u/p/1.mp4', true],
    ['http://h/live/u/p/1.ts', false],
    ['http://h/u/p/1.ts', false],
    ['http://h/movies-catalog/1.ts', false],
  ])('%s -> %s', (url, expected) => {
    expect(isOnDemandUrl(url)).toBe(expected);
  });
});
