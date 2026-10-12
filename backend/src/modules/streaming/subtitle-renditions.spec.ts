import { SubtitleStreamService } from './subtitle-stream.service';

describe('listTextSubtitleRenditions', () => {
  it('offers only external sidecars that can become WebVTT', async () => {
    const rows = [
      {
        id: 1,
        relativePath: 'm.en.sup',
        codec: 'hdmv_pgs_subtitle',
        language: 'en',
      },
      { id: 2, relativePath: 'm.en.sub', codec: null, language: 'en' },
      { id: 3, relativePath: 'm.en.SRT', codec: null, language: 'en' },
      { id: 4, relativePath: 'm.fr.vtt', codec: null, language: 'fr' },
      { id: 5, relativePath: null, codec: 'subrip', language: 'de' },
    ];
    const svc = new SubtitleStreamService(
      { find: jest.fn().mockResolvedValue(rows) } as never,
      null as never,
      {
        resolveFile: jest
          .fn()
          .mockResolvedValue({ mediaFile: { streamInfo: null } }),
      } as never,
      null as never,
      null as never,
      null as never,
    );
    const out = await svc.listTextSubtitleRenditions(1);
    expect(out.map((r) => r.key)).toEqual([3, 4]);
  });

  it('carries the embedded BCP-47 tag next to the canonical language', async () => {
    const svc = new SubtitleStreamService(
      { find: jest.fn().mockResolvedValue([]) } as never,
      null as never,
      {
        resolveFile: jest.fn().mockResolvedValue({
          mediaFile: {
            streamInfo: {
              subtitles: [
                { streamIndex: 3, language: 'chi', languageTag: 'zh-Hant', codec: 'subrip' },
                { streamIndex: 4, language: 'eng', codec: 'subrip' },
              ],
            },
          },
        }),
      } as never,
      null as never,
      null as never,
      null as never,
    );
    const out = await svc.listTextSubtitleRenditions(1);
    expect(out.map((r) => [r.language, r.languageTag])).toEqual([
      ['zh', 'zh-Hant'],
      ['en', undefined],
    ]);
  });
});
