import { CustomFormatsService } from '../../src/modules/profiles/custom-formats.service';
import type { CustomFormat } from '../../src/modules/profiles/entities/custom-format.entity';
import { maybeDiverge, RELEASES } from './_corpus';
import { emit, mulberry32, pick, ri } from './_util';
import { APP_LANGUAGES } from '../../src/common/constants/app-languages';

const rng = mulberry32(0xcf01);
const chance = (p: number) => rng() < p;

const fmt = (specs: object[], over: object = {}) => ({ id: 1, name: 'fmt', score: 10, specs, ...over });
const match = (formats: object[], title: string, flags?: string[]) => ({ fn: 'match', formats, title, flags });
const validate = (specs: object[]) => ({ fn: 'validateTitleRegexes', specs });

const BLURAY = 'Some.Show.2024.1080p.BluRay.x264-GRP';
const WEBRIP = 'Some.Show.2024.1080p.WEBRip.x264-GRP';
const s = (type: string, value: string, extra: object = {}) => ({ type, value, ...extra });

// custom-formats.service.spec.ts
const specInputs: unknown[] = [
  match([fmt([s('resolution', '1080p')])], BLURAY),
  match([fmt([s('resolution', '1080p'), s('source', 'bluray')])], BLURAY), match([fmt([s('resolution', '1080p'), s('source', 'bluray')])], WEBRIP),
  match([fmt([s('source', 'bluray'), s('source', 'webrip')])], BLURAY), match([fmt([s('source', 'bluray'), s('source', 'webrip')])], WEBRIP),
  match([fmt([s('source', 'bluray'), s('source', 'webrip')])], 'Some.Show.2024.1080p.HDTV.x264-GRP'),
  match([fmt([s('source', 'bluray', { required: true }), s('source', 'webrip')])], WEBRIP), match([fmt([s('source', 'bluray', { required: true }), s('source', 'webrip')])], BLURAY),
  match([fmt([s('source', 'webrip', { negate: true })])], BLURAY), match([fmt([s('source', 'webrip', { negate: true })])], WEBRIP),
  match([fmt([s('source', 'web-dl')])], 'Some.Show.2024.1080p.WEBDL.x264-GRP'), match([fmt([s('source', 'web-dl')])], 'Some.Show.2024.1080p.WEB-DL.x264-GRP'), match([fmt([s('source', 'web-dl')])], WEBRIP),
  match([fmt([s('language', 'it')])], 'Some.Show.2024.1080p.ITA.BluRay.x264-GRP'), match([fmt([s('language', 'it')])], 'Whitewater.2024.1080p.BluRay.x264-GRP'),
  match([fmt([s('resolution', '2160p')])], 'Some.Show.2024.2160p.BluRay.x265-GRP'), match([fmt([s('resolution', '2160p')])], 'Some.Show.2024.UHD.BluRay.x265-GRP'), match([fmt([s('resolution', '2160p')])], BLURAY),
  match([fmt([s('release_group', 'GRP')])], BLURAY), match([fmt([s('edition', 'imax')])], 'Some.Show.2024.IMAX.1080p.BluRay-GRP'), match([fmt([s('video_codec', 'h264')])], BLURAY),
  match([fmt([s('audio_codec', 'truehd')])], 'Some.Show.2024.1080p.TrueHD-GRP'),
  match([fmt([s('release_flag', 'freeleech')])], BLURAY, ['freeleech']), match([fmt([s('release_flag', 'freeleech')])], BLURAY, []), match([fmt([s('release_flag', 'halfleech')])], BLURAY, ['halfleech']),
  match([fmt([s('release_flag', 'internal')])], BLURAY, ['internal']), match([fmt([s('release_flag', 'internal')])], BLURAY, ['freeleech']),
  match([fmt([s('title_regex', 'blu-?ray')])], BLURAY), match([fmt([s('title_regex', '[(')])], BLURAY), match([fmt([])], BLURAY),
  match([fmt([s('source', 'bluray')], { id: 1, score: 100 }), fmt([s('source', 'webrip')], { id: 2, score: -50 }), fmt([s('resolution', '1080p')], { id: 3, score: 5 })], BLURAY),
  match([fmt([s('source', 'bluray')], { id: 1, score: 100 }), fmt([s('source', 'webrip')], { id: 2, score: -50 }), fmt([s('resolution', '1080p')], { id: 3, score: 5 })], WEBRIP),
  validate([s('title_regex', 'ok'), s('source', '[(')]), validate([s('title_regex', '[(')]), validate([]),
];

// title_regex values: valid, invalid, lookaround, Annex B oddities, case folding
const REGEX = [
  'blu-?ray', '[(', '(?<=\\.)\\d{4}', '(?<!x)264', '\\bhdr\\b', '^the', 'WEB.?DL', '(\\d)\\1', '(?<year>\\d{4})', '(?<y>\\d{4}).*\\k<y>', 'x26[45]', '[', '(', '*', '+a', 'a{2,1}', '\\',
  '(?i)x', '\\p{L}', '[\\w-a]', '\\d{', 'a{,5}', '\\1', '(?=a)*', ']', '}', '{', '\\c', '[^]', '[]', '.+', '^$', 'İ', 'É', 'é', 'S01E0[1-3]', '\\.mkv$', '-grp$',
  'x264|x265', '(?:french|vostfr)', '\\d+p', '\\s', '[\\s.]', '\\bsdh\\b', 'ΣΑΣ', 'ς', '\\u0130', 'k', 's', '\\x41', '\\/', '(a+)+b', '.*\\.(mkv|mp4)', '^(?!.*cam)', '(?<=-)[a-z]+$', '\\B', '$^', '[a-z]{2,}', 'ê', '\\w+\\W\\w+',
];
const ANNEX_B = ['\\8', '\\08', '\\1(a)', '(a)\\2', '(?=a){2}', 'a{', 'a{1', 'a{1,', '\\k', '\\k<n>', '[\\b]', '\\-', '[a-\\d]', '[\\d-z]', '\\_', '\\ca', '\\c1', '[\\c1]', '[\\c]', '\\0', '\\00', '\\x4', '\\xg', '\\u12', '\\ug', '\\P{L}', 'x{2,3}?', '(?<n>a)\\k<n>', '^*', '$*', '(?:a)??', '[--a]', '[a-]', '[-a]', '\\Z', '\\A', '(?<!a)b', '(?<=a)(?=b)', '[\\s-x]', '(?:)', '()', '|', 'a|', '|a', '\\d{2}(?=p)', '\\D', '\\S+', '[^\\s]', '(?<a>x)|(?<a>y)', 'a**', '(*)', '\\u0041', '\\u{1F600}', '.', '(?s).', '(?m)^a', '\\cJ', '^\\w+$', '\\u00e9', 'É', 'é', '[À-ÿ]', '\\Bx', 'x\\b'];
const VALUES: Record<string, string[]> = {
  title_regex: [...REGEX, ...ANNEX_B],
  source: ['web-dl', 'WEBDL', 'bluray', 'Blu-Ray', 'remux', 'hdtv', 'webrip', 'web.rip', 'cam', 'ts', 'tc', 'dvd', 'sdtv', 'x', ''],
  resolution: ['1080p', '2160p', '4k', '720', 'p1080', '', '1080 ', '0', '4320p', '480p', '8k'],
  language: ['it', 'ITA', 'Italian', 'fr', 'French', 'fre', 'fra', 'en', 'English', 'eng', 'xx', 'multi', 'de', 'zh', 'chi', 'zho', 'Unknown'],
  release_flag: ['freeleech', 'free-leech', 'Internal', 'halfleech', 'FREELEECH', 'x', ''],
  release_group: ['GRP', 'grp', 'CtrlHD', 'dl', '-GRP', 'Éclair', 'mkv', 'x264'],
  edition: ['imax', 'Directors Cut', 'directors-cut', 'extended', 'DC', 'remastered'],
  video_codec: ['h264', 'x264', 'H.265', 'hevc', 'h265', 'av1', 'AV1', 'xvid', 'mpeg2', 'vp9'],
  audio_codec: ['truehd', 'DTS-HD', 'dtshd', 'eac3', 'E-AC-3', 'ddp', 'aac', 'AAC', 'ac3', 'dts', 'flac'],
};
const TYPES = [...Object.keys(VALUES), 'unknown_type'];
const FLAGS = [[], ['freeleech'], ['halfleech'], ['internal'], ['FreeLeech', 'x']];
const TITLES = [...RELEASES, 'Movie.k.2019.1080p', 'Movie.s01E01', 'ΣΑΣ.1080p', 'Movie.2019.İ.ITA', 'Movie.2019.Éclair.1080p-GRP'];
const gen: unknown[] = [];
for (let i = 0; i < 500; i++) {
  const formats = Array.from({ length: ri(rng, 1, 3) }, (_, k) => fmt(
    Array.from({ length: ri(rng, 0, 4) }, () => {
      const type = chance(0.03) ? 'unknown_type' : pick(rng, TYPES.slice(0, 9));
      const spec: Record<string, unknown> = { type, value: type === 'unknown_type' ? 'x' : pick(rng, VALUES[type]) };
      if (chance(0.25)) spec.negate = chance(0.7);
      if (chance(0.2)) spec.required = chance(0.7);
      return spec;
    }),
    { id: k + 1, name: `f${k}`, score: pick(rng, [-100, -5, 0, 5, 10, 100]) },
  ));
  // regress folds U+017F and U+212A like `u` and reads \u{41} as a code point (V8 does neither): left out of title_regex cases
  const raw = pick(rng, TITLES);
  let title = maybeDiverge(rng, raw, 0.2);
  if (/[\u017f\u212a]/.test(title) && formats.some((f) => f.specs.some((x: any) => x.type === 'title_regex'))) title = raw;
  gen.push(match(formats, title, pick(rng, FLAGS)));
}
// every title_regex value against a spread of titles
for (const re of [...REGEX, ...ANNEX_B]) for (const t of [BLURAY, 'aaab 1a1 a{ k<n> u ab-c aa', 'Éé À ÿ \u00e9 x\bx', 'Some.Show.S01E02.1080p.WEB-DL.DDP5.1.x265-GRP', 'Movie.2019.FRENCH.720p.HDTV.x264-GRP.mkv', 'ΣΑΣ.1080p', 'Éclair.2010.1080p', 'x264 x264 12 1212 abab'])
  gen.push(match([fmt([s('title_regex', re)])], t), ...(re.length < 6 ? [match([fmt([s('title_regex', re, { negate: true })])], t)] : []));
for (let i = 0; i < 20; i++) gen.push(validate(Array.from({ length: ri(rng, 0, 3) }, () => s(pick(rng, ['title_regex', 'title_regex', 'source']), pick(rng, REGEX)))));

const run = (i: any): unknown => {
  if (i.fn === 'validateTitleRegexes') {
    try {
      (new CustomFormatsService({} as never) as any).assertRegexesCompile(i.specs);
      return null;
    } catch (e: any) {
      return String(e.message).replace(/^Invalid regular expression: /, '');
    }
  }
  const formats: CustomFormat[] = i.formats.map((f: object) => ({ ...f }) as CustomFormat);
  const service = new CustomFormatsService({ find: async () => formats } as never);
  return service.testRelease(i.title, i.flags).then((test) => ({ test, score: service.scoreReleaseWith(formats, i.title, i.flags) }));
};

(async () => {
  await emit('app-languages', [{ fn: 'APP_LANGUAGES' }], () => APP_LANGUAGES);
  await emit('custom-formats', [...specInputs, ...gen], run);
  console.log(`custom-formats total=${specInputs.length + gen.length} spec=${specInputs.length} generated=${gen.length}`);
})();
