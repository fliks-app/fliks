import {
  extractMediaTitle,
  parseReleaseAttributes,
  parseReleaseLanguage,
  parseSeasonEpisode,
  qualityFromResolution,
  releaseCoverage,
  resolveUnknownLanguage,
  within,
} from '../../src/common/release-parsing';
import { bucketResolutionHeight } from '../../src/common/utils/resolution.util';
import { decodeHtmlEntities } from '../../src/common/utils/decode-html-entities';
import { APP_LANGUAGES } from '../../src/common/constants/app-languages';
import { maybeDiverge, NOISE, SEPS, WORDS } from './_corpus';
import { emit, mulberry32, pick, ri } from './_util';

const se = (title: string) => ({ fn: 'parseSeasonEpisode', title });
const cov = (title: string) => ({ fn: 'releaseCoverage', title });
const attrs = (title: string) => ({ fn: 'parseReleaseAttributes', title });
const lang = (title: string) => ({ fn: 'parseReleaseLanguage', title });
const unk = (id: number, iso?: string | null) => ({ fn: 'resolveUnknownLanguage', id, iso });
const extract = (name: string) => ({ fn: 'extractMediaTitle', name });
const decode = (s: string) => ({ fn: 'decodeHtmlEntities', s });
const qfr = (text: string, width?: number | null, height?: number | null) => ({ fn: 'qualityFromResolution', text, width, height });
const bucket = (width?: number | null, height?: number | null) => ({ fn: 'bucketResolutionHeight', width, height });

// season-episode.parser.spec.ts, quality-from-resolution.spec.ts, title.extractor.spec.ts
const spec: unknown[] = [
  'Show.Name.S01E02.1080p.WEB-DL', 'show.name.s10e11.HDTV', 'Show.Name.S01.1080p.WEB-DL.PACK', 'Show Name Season 03 Complete', 'Show.Name.1x02.DVDRip',
  'Inception.2010.1080p.BluRay.x264', 'Show.S02E05.1080p', 'Show.Name.Spinoff.S01.1080p.x265-GROUP', 'Show.Name.S09.1080p.x265-GROUP',
  'Show.S01E05.1080p', 'Show.S01E04E05.1080p', 'Show.S01E04-E05.1080p', 'Show.S01E04-05.1080p', 'Show.S01E01E02E03.1080p', 'Show.1x04-05.DVDRip', 'Show.S02.1080p',
  'Show.S01-S04.1080p', 'Show.S01-04.1080p', 'Show S01 to S04 1080p', 'Show Season 1-4 1080p', 'Show Seasons 1 to 4 1080p', 'Show.Complete.Series.1080p',
  'The.Complete.Series.1080p', 'Show.Intégrale.1080p', 'Show.INTEGRALE.FRENCH', 'Show Saison 1 à 4', 'Show.Saisons.1-4.MULTI', 'Show.Saison.1.a.4',
  'Show.Integrale.Saisons.1.a.4', '[SubsPlease] Show S2 - 04 (1080p)', '[Grp] Show S01 - 12 [1080p]', 'Show Season 2 - 05 [1080p]', 'Show.S01.S02.S03.1080p',
  'Show.2019-2020.1080p.WEB-DL.x265', 'Show.1080p.DDP5.1.10bit.x265-GRP', 'Movie.2019.2160p.BluRay.5.1', 'Show.Complete.Edition.2010', 'Show.Complete.Collection',
  'Show.1080p.Complete.Pack', 'Show.COMPLETE.720p', 'Show.E01-E12.1080p', 'Show.S05x265.1080p', 'Show.1920x1080.WEB',
  'Show.S01-1080p.WEB', 'Show.S01.2019-2020.1080p', 'Show.S01-10bit.x265', 'Show.S01.COMPLETE.1080p', 'Show.S04-S02.1080p', 'Show S01 - 5.1 AAC', 'Show.S01.S03.1080p',
  'Show.S01,S03,S05.1080p', 'Show.S01 to 04.1080p', 'Show.S01E04-1080p.WEB', 'Show.S01E01-S02E05.1080p', 'Show.S01E04.E05.1080p',
].flatMap((t) => [se(t), cov(t)]);
for (const [a, b] of [[1, 2], [2, 4], [4, 2], [3, 3]]) for (const n of [1, 2, 3, 4, 5]) spec.push({ fn: 'within', range: { from: a, to: b }, n });
spec.push(
  qfr('The.Fall.Guy.2024.2160p.WEB-DL.x265', 1920, 804), qfr('Movie.2024.2160p.WEB-DL', 3840, 2160), qfr('Movie.2024.1080p.Remux', 1920, 1080), qfr('Movie 2024 1080', 1920, 1080),
  extract('sample.mkv'), extract('Lonely.Harbor.2021.1080p.mkv'),
);

// ---- season / episode grammar
const rng = mulberry32(0x5e11);
const num2 = () => String(ri(rng, 0, 99)).padStart(2, '0');
const num3 = () => String(ri(rng, 0, 120)).padStart(rng() < 0.5 ? 2 : 1, '0');
const FORMS: Array<(sep: string) => string> = [
  () => `S${num2()}E${num3()}`,
  () => `S${num2()}E${num3()}E${num3()}`,
  () => `S${num2()}E${num3()}-E${num3()}`,
  () => `S${num2()}E${num3()}-${num3()}`,
  () => `S${num2()}E${num3()}E${num3()}E${num3()}`,
  () => `S${num2()}E${num3()}-S${num2()}E${num3()}`,
  () => `${ri(rng, 0, 99)}x${num3()}`,
  () => `${ri(rng, 1, 12)}x${num3()}-${num3()}`,
  () => `${ri(rng, 1, 12)}x${pick(rng, ['264', '265', '2640', '26'])}`,
  () => `S${num2()}x${pick(rng, ['265', '264', '05'])}`,
  () => `S${num2()}-S${num2()}`,
  () => `S${num2()}-${num2()}`,
  (s) => `S${num2()}${s}to${s}S${num2()}`,
  (s) => `S${num2()}${s}${pick(rng, ['à', 'a', '-'])}${s}S${num2()}`,
  () => `S${num2()} to ${num2()}`,
  (s) => `Season${s}${ri(rng, 1, 9)}-${ri(rng, 1, 9)}`,
  (s) => `Seasons${s}${ri(rng, 1, 9)}${s}to${s}${ri(rng, 1, 9)}`,
  (s) => `Saison${s}${ri(rng, 1, 9)}${s}${pick(rng, ['à', 'a', 'to'])}${s}${ri(rng, 1, 9)}`,
  (s) => `Saisons${s}${ri(rng, 1, 9)}-${ri(rng, 1, 9)}`,
  (s) => { const a = ri(rng, 1, 7); return `S0${a}${s}S0${a + 1}${s}S0${a + 2}`; },
  () => { const a = ri(rng, 1, 7); return `S0${a},S0${a + 2},S0${a + 4}`; },
  (s) => `S${ri(rng, 1, 9)}${s}-${s}${num3()}`,
  (s) => `S${ri(rng, 1, 9)}${s}-${s}${ri(rng, 1, 9)}.${ri(rng, 0, 9)}`,
  (s) => `S${ri(rng, 1, 9)}${s}-${s}${num3()}-${num3()}`,
  (s) => `Season${s}${ri(rng, 1, 9)}${s}-${s}${num3()}`,
  () => `S${num2()}`,
  () => `S${num2()}-${pick(rng, ['1080p', '10bit', '720p', 'x265'])}`,
  (s) => `Season${s}${num2()}`,
  (s) => `Saison${s}${num2()}`,
  (s) => `Complete${s}Series`,
  () => pick(rng, ['Intégrale', 'INTEGRALE', 'integrale', 'Integrale']),
  () => `Complete${pick(rng, ['', '.', '-', '_', ' '])}Series.S0${ri(rng, 1, 4)}`,
  () => pick(rng, ['Complete.Edition', 'Complete.Pack', 'COMPLETE', 'Complete.Collection', 'E01-E12', '1920x1080', 'S1E', 'S100E1']),
];
const seGen: unknown[] = [];
while (seGen.length < 700) {
  const sep = pick(rng, SEPS);
  const noise = Array.from({ length: ri(rng, 0, 3) }, () => pick(rng, NOISE));
  const parts = [pick(rng, WORDS), ...(rng() < 0.3 ? [pick(rng, ['2019', '1999', '2020'])] : []), FORMS[seGen.length % FORMS.length](sep), ...noise];
  let t = parts.join(sep);
  if (rng() < 0.2) t = t.toUpperCase();
  else if (rng() < 0.2) t = t.toLowerCase();
  t = maybeDiverge(rng, t, 0.3);
  seGen.push(rng() < 0.5 ? se(t) : cov(t));
}

// ---- attributes
const ALT = {
  res: ['4320p', '4320', '8k', '2160p', '2160', '4k', 'UHD', '1080p', '1080i', '1080', '720p', '720i', '720', '576p', '576', '480p', '480', '360p', '360', '1440p', '2160x'],
  src: ['remux', 'bluray', 'blu-ray', 'bluray', 'bdrip', 'brrip', 'bdr', 'web-dl', 'webdl', 'web.dl', 'web-rip', 'webrip', 'web', 'hdtv', 'dvd', 'dvdrip', 'dvdr', 'dvd-r', 'sdtv', 'cam', 'hdcam', 'ts', 'telesync', 'tc', 'telecine', 'telecined', 'tcl'],
  vid: ['h265', 'h.265', 'h 265', 'x265', 'hevc', 'h264', 'h.264', 'x264', 'avc', 'av1', 'vp9', 'xvid', 'mpeg2', 'mpeg-2', 'mpg2', 'mpeg 2'],
  aud: ['truehd', 'dts-hd', 'dtshd', 'dts', 'eac3', 'e-ac3', 'eac-3', 'e-ac-3', 'ddp', 'ac3', 'ac-3', 'dd5', 'flac', 'aac', 'opus', 'mp3'],
  ed: ['directors cut', "director's cut", 'directors.cut', 'director_s-cut', 'directorscut', 'directors-cut', 'dc', 'extended', 'theatrical', 'uncut', 'remastered', 'criterion', 'imax', 'ext'],
  hi: ['sdh', 'hi', 'hearing impaired', 'hearing-impaired', 'hearing_impaired', 'hearingimpaired', 'cc', 'closed caption', 'closed-caption', 'closedcaption', 'high'],
};
const TAILS = ['', '-GRP', '-grp_2', '-1080p', '-x264', '-DL', '-WEB', '-REMUX', '.mkv', '-GRP.mkv', '-GRP.MKV', '.torrent', '.x264', '-GRP.', '-GRP.a', '-Éclair'];
const alts = Object.values(ALT).flat();
const attrGen: unknown[] = [];
for (let i = 0; attrGen.length < 700; i++) {
  const token = alts[i % alts.length];
  const sep = pick(rng, ['.', ' ', '-', '_']);
  const noise = rng() < 0.6 ? Array.from({ length: ri(rng, 1, 3) }, () => pick(rng, [...NOISE, ...alts])) : [];
  let t = [pick(rng, WORDS), ...noise, token].sort(() => (rng() < 0.15 ? 0.5 - rng() : 0)).join(sep) + pick(rng, TAILS);
  if (rng() < 0.2) t = t.toUpperCase();
  attrGen.push(attrs(maybeDiverge(rng, t, 0.2)));
}

// ---- language
const KW = {
  fr: ['french', 'vff', 'vfi', 'vf', 'truefrench', 'vostfr', 'vost'], de: ['german', 'deutsch'], es: ['spanish', 'espanol', 'esp', 'spa', 'latino'], it: ['italian', 'italiano', 'ita'],
  pt: ['portuguese', 'portugués', 'portugues', 'pt-br', 'pt br', 'ptbr', 'por', 'portuguêse'], ja: ['japanese', 'japonais', 'japones', 'japonaes', 'jap', 'jpn'], ko: ['korean', 'coréen', 'coreen', 'coréen', 'kor'],
  zh: ['chinese', 'chinois', 'chi', 'chn', 'mandarin', 'cantonese'], ru: ['russian', 'russe', 'rus'], ar: ['arabic', 'arabe', 'ara'], nl: ['dutch', 'nl', 'nlx', 'flemish'],
  pl: ['polish', 'polonais', 'pol', 'pl'], tr: ['turkish', 'turc', 'tur'], sv: ['swedish', 'suédois', 'suedois', 'swe', 'sv'], da: ['danish', 'danois', 'dan', 'dk'],
  no: ['norwegian', 'norvégien', 'norvegien', 'nor', 'no'], fi: ['finnish', 'finlandais', 'fin'], multi: ['multi', 'MULTi'],
};
const kws = Object.values(KW).flat();
const langGen: unknown[] = [];
for (let i = 0; langGen.length < 500; i++) {
  const kw = kws[i % kws.length];
  const sep = pick(rng, ['.', '_', '-', ' ']);
  const shape = ri(rng, 0, 5);
  const word = rng() < 0.3 ? kw.toUpperCase() : kw;
  const base = pick(rng, ['Movie.2019.1080p', 'Show.S01E01', 'No.Country', 'Title']);
  const t = [
    `${base}${sep}${word}${sep}x264`, `${word}${sep}${base}`, `${base}${sep}${word}`, `${base}${sep}x${word}`, `${base}${sep}${word}x`, `${base}${sep}É${word}${sep}x`,
    `${base}${sep}${word}É${sep}x`,
  ][shape];
  langGen.push(lang(maybeDiverge(rng, t, 0.15)));
}
const unkGen: unknown[] = [];
for (const l of APP_LANGUAGES) for (const iso of [undefined, null, '', 'fr', 'xx', 'zz', l.isoCode]) unkGen.push(unk(l.id, iso));

// ---- extractMediaTitle
const TITLES = ['Lonely.Harbor', 'The Crown', 'Nova_Skyline', 'Caf&eacute; Society', 'Tom &amp; Jerry', '1917', 'Spy-Fi', 'Show Season 2 Special', "L'Impossible", 'Éclair', '&#8364;uro Trip', 'Dr. Who', 'S1 Cinema', '2001 A Space Odyssey'];
const YEARS = ['', '.2021', ' (2010)', '.2019.2020', '.1899', '.2100', '.19999'];
const MARK = ['', '.S01E02', '.S02', '.Season.3', '.1x05', '.Complete.Series', '.Complete.S01', ' - 03', '.s1'];
const TAIL = ['', '.1080p.BluRay.x264-GRP', '.720p.HDTV', '.5.1.DTS', '.WEB-DL.AAC', '.HDR.2160p'];
const EXT = ['', '.mkv', '.MKV', '.mp4', '.avi', '.ts', '.m2ts', '.txt', '.torrent', '.mkv.torrent', '.nfo'];
const exGen: unknown[] = [];
for (let i = 0; exGen.length < 400; i++) {
  const sep = pick(rng, ['.', '_', ' ']);
  const name = pick(rng, TITLES) + pick(rng, YEARS) + pick(rng, MARK) + pick(rng, TAIL) + pick(rng, EXT);
  exGen.push(extract(maybeDiverge(rng, name.replace(/\./g, rng() < 0.7 ? '.' : sep), 0.15)));
}
exGen.push(extract(''), extract('.mkv'), extract('...'), extract('[Grp] Show - 03 [1080p].mkv'), extract('1917.2019.1080p'), extract('  Spaced  Title  2020  '), extract('Name (2010)'), extract('Name [2010]'));

// ---- decodeHtmlEntities
const decodeSrc = require('fs').readFileSync(require('path').join(__dirname, '../../src/common/utils/decode-html-entities.ts'), 'utf8') as string;
const names = [...decodeSrc.matchAll(/\b([A-Za-z][A-Za-z0-9]*): '/g)].map((m) => m[1]).concat(['amp', 'lt', 'gt', 'quot', 'apos']);
const decGen: unknown[] = [];
for (const n of new Set(names)) decGen.push(decode(`a&${n};b`), decode(`&${n.toUpperCase()};`));
const numeric = ['#0;', '#1;', '#9;', '#65;', '#x41;', '#X41;', '#x61;', '#xAB;', '#xab;', '#12ab;', '#ab;', '#00065;', '#x00041;', '#1114111;', '#1114112;', '#x10FFFF;', '#x110000;', '#99999999999999999999;', `#${'9'.repeat(400)};`, `#x${'F'.repeat(300)};`, '#xD7FF;', '#xE000;', '#8364;', '#x20AC;', '#x1F600;', '#128512;', '#;', '#x;', '&;', 'nosuch;', 'AMP;', 'eacute', '#65', '#x41', '#xg1;', '#1a;', '#-5;', '#+5;', '#65 ;'];
for (const n of numeric) decGen.push(decode(`&${n}`), decode(`pre&${n}post`), decode(`&&${n}&`));
decGen.push(decode(''), decode('plain'), decode('&amp;amp;'), decode('&amp;lt;'), decode('&lt;&gt;&amp;&quot;&apos;&nbsp;x'), decode('Berl&iacute;n'), decode('&#38;#38;'));
while (decGen.length < 250) decGen.push(decode(`${pick(rng, ['a', 'Z', ' ', '&'])}&${pick(rng, [...names])};${pick(rng, ['', '&amp;', '&#65;'])}`));

// ---- resolution grid
const CEIL = [[256, 192], [426, 320], [640, 432], [854, 576], [1280, 962], [1920, 1440]];
const SRC = ['', 'Movie.2020.Remux', 'Movie.BluRay.1080p', 'Movie.WEB-DL', 'Movie.WEBRip', 'Movie.DVDRip', 'Movie.BDR', 'Movie.SDTV', 'web dl', 'WEB-RIP'];
const dims: Array<[number | null | undefined, number | null | undefined]> = [[undefined, undefined], [null, null], [0, 0], [0, 100], [100, 0], [-1, -1], [undefined, 720], [1920, undefined], [3840, 2160], [7680, 4320]];
for (const [w, h] of CEIL) for (const dw of [-1, 0, 1]) for (const dh of [-1, 0, 1]) dims.push([w + dw, h + dh], [w + dw, 1], [1, h + dh]);
const resGen: unknown[] = [];
for (const [w, h] of dims) { resGen.push(bucket(w, h)); resGen.push(qfr(SRC[resGen.length % SRC.length], w, h)); }
for (let i = 0; i < 450 - resGen.length + 0; i++) { const [w, h] = pick(rng, dims); resGen.push(qfr(pick(rng, SRC), w, h)); }

function run(i: any): unknown {
  switch (i.fn) {
    case 'parseSeasonEpisode': return parseSeasonEpisode(i.title);
    case 'releaseCoverage': return releaseCoverage(i.title);
    case 'within': return within(i.range, i.n);
    case 'parseReleaseAttributes': return parseReleaseAttributes(i.title);
    case 'parseReleaseLanguage': return parseReleaseLanguage(i.title);
    case 'resolveUnknownLanguage': return resolveUnknownLanguage(APP_LANGUAGES.find((l) => l.id === i.id)!, i.iso ?? undefined);
    case 'extractMediaTitle': return extractMediaTitle(i.name);
    case 'decodeHtmlEntities': return decodeHtmlEntities(i.s);
    case 'qualityFromResolution': return qualityFromResolution(i.text, i.width ?? undefined, i.height ?? undefined);
    default: return bucketResolutionHeight(i.width, i.height);
  }
}

(async () => {
  const all = [...spec, ...seGen, ...attrGen, ...langGen, ...unkGen, ...exGen, ...decGen, ...resGen];
  await emit('release-parsing', all, run);
  console.log(`release-parsing total=${all.length} spec=${spec.length} se=${seGen.length} attrs=${attrGen.length} lang=${langGen.length} unk=${unkGen.length} extract=${exGen.length} decode=${decGen.length} res=${resGen.length}`);
})();
