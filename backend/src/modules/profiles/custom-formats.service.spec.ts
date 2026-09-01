import { CustomFormatsService } from './custom-formats.service';
import type { CustomFormat, CustomFormatSpec } from './entities/custom-format.entity';

function format(
  specs: CustomFormatSpec[],
  over: Partial<CustomFormat> = {},
): CustomFormat {
  return { id: 1, name: 'fmt', score: 10, specs, ...over } as CustomFormat;
}

describe('CustomFormatsService matching', () => {
  const service = new CustomFormatsService({} as never);
  const score = (
    fmt: CustomFormat,
    title: string,
    meta?: { freeleech?: boolean; downloadVolumeFactor?: number },
  ) => service.scoreReleaseWith([fmt], title, meta);

  const BLURAY_1080 = 'Some.Show.2024.1080p.BluRay.x264-GRP';
  const WEBRIP_1080 = 'Some.Show.2024.1080p.WEBRip.x264-GRP';

  it('scores a format whose only condition matches', () => {
    expect(score(format([{ type: 'resolution', value: '1080p' }]), BLURAY_1080)).toBe(10);
  });

  it('requires every condition type, not just one of them', () => {
    const fmt = format([
      { type: 'resolution', value: '1080p' },
      { type: 'source', value: 'bluray' },
    ]);
    expect(score(fmt, BLURAY_1080)).toBe(10);
    // 1080p alone used to be enough: the two conditions were OR-ed together.
    expect(score(fmt, WEBRIP_1080)).toBe(0);
  });

  it('treats conditions of the same type as alternatives', () => {
    const fmt = format([
      { type: 'source', value: 'bluray' },
      { type: 'source', value: 'webrip' },
    ]);
    expect(score(fmt, BLURAY_1080)).toBe(10);
    expect(score(fmt, WEBRIP_1080)).toBe(10);
    expect(score(fmt, 'Some.Show.2024.1080p.HDTV.x264-GRP')).toBe(0);
  });

  it('a required condition must hold whatever its alternatives do', () => {
    const fmt = format([
      { type: 'source', value: 'bluray', required: true },
      { type: 'source', value: 'webrip' },
    ]);
    expect(score(fmt, WEBRIP_1080)).toBe(0);
    expect(score(fmt, BLURAY_1080)).toBe(10);
  });

  it('negates a condition', () => {
    const fmt = format([{ type: 'source', value: 'webrip', negate: true }]);
    expect(score(fmt, BLURAY_1080)).toBe(10);
    expect(score(fmt, WEBRIP_1080)).toBe(0);
  });

  it('matches a source by its parsed value, not by substring', () => {
    const fmt = format([{ type: 'source', value: 'web-dl' }]);
    expect(score(fmt, 'Some.Show.2024.1080p.WEBDL.x264-GRP')).toBe(10);
    expect(score(fmt, 'Some.Show.2024.1080p.WEB-DL.x264-GRP')).toBe(10);
    expect(score(fmt, WEBRIP_1080)).toBe(0);
  });

  it('matches a language by its parsed value, not by substring', () => {
    const fmt = format([{ type: 'language', value: 'it' }]);
    expect(score(fmt, 'Some.Show.2024.1080p.ITA.BluRay.x264-GRP')).toBe(10);
    // 'it' appears in the title, which the substring check used to accept.
    expect(score(fmt, 'Whitewater.2024.1080p.BluRay.x264-GRP')).toBe(0);
  });

  it('matches a resolution numerically', () => {
    const fmt = format([{ type: 'resolution', value: '2160p' }]);
    expect(score(fmt, 'Some.Show.2024.2160p.BluRay.x265-GRP')).toBe(10);
    expect(score(fmt, 'Some.Show.2024.UHD.BluRay.x265-GRP')).toBe(10);
    expect(score(fmt, BLURAY_1080)).toBe(0);
  });

  it('matches release group, edition and codecs', () => {
    expect(score(format([{ type: 'release_group', value: 'GRP' }]), BLURAY_1080)).toBe(10);
    expect(
      score(format([{ type: 'edition', value: 'imax' }]), 'Some.Show.2024.IMAX.1080p.BluRay-GRP'),
    ).toBe(10);
    expect(score(format([{ type: 'video_codec', value: 'h264' }]), BLURAY_1080)).toBe(10);
    expect(
      score(format([{ type: 'audio_codec', value: 'truehd' }]), 'Some.Show.2024.1080p.TrueHD-GRP'),
    ).toBe(10);
  });

  it('reads release flags from the caller, not the title', () => {
    const fmt = format([{ type: 'release_flag', value: 'freeleech' }]);
    expect(score(fmt, BLURAY_1080, { freeleech: true })).toBe(10);
    expect(score(fmt, BLURAY_1080, { freeleech: false })).toBe(0);
    expect(
      score(format([{ type: 'release_flag', value: 'halfleech' }]), BLURAY_1080, {
        downloadVolumeFactor: 0.5,
      }),
    ).toBe(10);
  });

  it('tests a regex against the untouched title', () => {
    expect(score(format([{ type: 'title_regex', value: 'blu-?ray' }]), BLURAY_1080)).toBe(10);
    expect(score(format([{ type: 'title_regex', value: '[(' }]), BLURAY_1080)).toBe(0);
  });

  it('never matches a format with no condition', () => {
    expect(score(format([]), BLURAY_1080)).toBe(0);
  });

  it('sums the scores of every matching format', () => {
    const formats = [
      format([{ type: 'source', value: 'bluray' }], { id: 1, score: 100 }),
      format([{ type: 'source', value: 'webrip' }], { id: 2, score: -50 }),
      format([{ type: 'resolution', value: '1080p' }], { id: 3, score: 5 }),
    ];
    expect(service.scoreReleaseWith(formats, BLURAY_1080)).toBe(105);
    expect(service.scoreReleaseWith(formats, WEBRIP_1080)).toBe(-45);
  });
});
