import { Logger } from '@nestjs/common';
import * as cleaner from '../../src/modules/subtitles/subtitle-cleaner';
import * as post from '../../src/modules/subtitles/subtitle-post-processor';
import { parseSrt, serializeSrt } from '../../src/modules/subtitles/srt.util';
import {
  assertSafeLangSuffix,
  resolveSubtitleAbsolutePath,
} from '../../src/modules/subtitles/subtitle-path.util';
import { relativePathUnderMediaRoot } from '../../src/common/utils/media-path.util';
import { sidecarLangSuffix, SubtitlesService } from '../../src/modules/subtitles/subtitles.service';
import {
  matchesRequestedFlags,
  prefersHearingImpaired,
  requestFlagsOf,
} from '../../src/common/constants/subtitle-flags';
import { hasCoveringSub } from '../../src/common/constants/subtitle-codecs';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);
const rng = mulberry32(0x5f11e);
const svc = Object.create(SubtitlesService.prototype) as any;

// ---- cleaner ---------------------------------------------------------------------------------
const PLAIN = ['Hello there.', "I don't know what you mean.", 'Where are you going?', '- Come on.', '- Wait for me!', 'It was a dark night.',
  'Bonjour, comment ça va ?', '<i>Italic line</i>', 'Look: it is fine', 'Les enfants sont là.', '日本語のセリフ', 'Check (12) times', 'Really (?)', 'Okay.'];
const ADS = ['Downloaded from www.opensubtitles.org', 'Sync by Foo & Bar', 'Support us and become VIP member', 'Visit https://example.com/x now',
  'Subtitles by Someone', 'Please rate this subtitle at www.osdb.link/xyz', 'Captions by Example Corp', 'advertise your product here', 'addic7ed.com', 'ASUB.COM',
  'Synced and corrected by x', 'www.my.site'];
const HI = ['[music playing]', '(sighs)', '♪ La la la ♪', '[door slams] Get out!', '（笑い）はい', '［拍手］', 'MAN: Where are you?', '- Rose: Hello there.', 'ROSE: Hi',
  'Rose: Hello again', 'Rose: Still here', 'DOOR SLAMS', 'LAUGHING', 'PHONE RINGING', 'HELLO THERE!', 'WHO ARE YOU?', 'THEY ARE COMING', '[laughing\nloudly] fine', '- [gasps]', '(…)',
  '[ ] x', '(a)', '¶ song ¶', '- MAN: Stop.', '<b></b>', '~ ~', '...'];
const EXCL = ['^Hello', 'dark\\s+night', '(?<=I )don', 'foo(', '', '   ', '(\\w+) \\1', 'ça va'];

function cue(i: number, lines: string[], eol: string): string {
  return [String(i), `00:00:${String(i).padStart(2, '0')},000 --> 00:00:${String(i).padStart(2, '0')},900`, ...lines].join(eol);
}

function doc(): string {
  const eol = rng() < 0.3 ? '\r\n' : '\n';
  const n = ri(rng, 1, 7);
  const cues: string[] = [];
  const caps = rng() < 0.3;
  for (let i = 1; i <= n; i++) {
    const pool = [PLAIN, PLAIN, HI, HI, ADS];
    const lines = Array.from({ length: ri(rng, 1, 3) }, () => {
      const l = pick(rng, pick(rng, pool));
      return caps && rng() < 0.7 ? l.toUpperCase() : l;
    });
    cues.push(cue(i, lines, eol));
  }
  if (rng() < 0.1) cues.splice(ri(rng, 0, cues.length), 0, 'WEBVTT-ish stray block');
  if (rng() < 0.1) cues.push(cue(n + 1, [], eol));
  const bom = rng() < 0.1 ? '﻿' : '';
  return bom + cues.join(eol + eol) + (rng() < 0.5 ? eol : '');
}

const cleanerCases: unknown[] = [];
const SAMPLE = [
  '1\n00:00:01,000 --> 00:00:02,000\n[music]\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nVisit www.opensubtitles.org\n\n3\n00:00:05,000 --> 00:00:06,000\n(sighs) Okay.\n',
  '1\r\n00:00:01,000 --> 00:00:02,000\r\nMAN: Hi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nMAN: Again\r\n',
  '',
  '\n\n',
  'x',
  '00:00:01,000 --> 00:00:02,000\nno index line\n\n00:00:03,000 --> 00:00:04,000\n[x] y',
];
for (const content of SAMPLE) {
  for (const removeHiTags of [false, true]) {
    cleanerCases.push({ fn: 'cleanSubtitle', content, removeAds: true, removeHiTags, customExclusions: [] });
  }
}
for (let i = 0; i < 240; i++) {
  cleanerCases.push({
    fn: 'cleanSubtitle',
    content: doc(),
    removeAds: rng() < 0.7,
    removeHiTags: rng() < 0.6,
    customExclusions: rng() < 0.3 ? Array.from({ length: ri(rng, 1, 3) }, () => pick(rng, EXCL)) : [],
  });
}

// ---- post-processor --------------------------------------------------------------------------
const ASS = [
  'Dialogue: 0,0:01:23.45,0:01:26.78,Default,,0,0,0,,Text here',
  'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}Hello, world\\Nsecond line',
  'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,',
  'Dialogue: 0,bad,0:00:04.00,Default,,0,0,0,,x',
  'Dialogue: short',
];
const SRT_BASE = '1\n00:00:01,000 --> 00:00:02,500\nHELLO THERE\n\n2\n00:59:59,999 --> 01:00:01,000\nit is ok. WHO IS THIS\nTHAT ONE\n\n3\n00:00:03,000 --> 00:00:04,000\nשלום עולם\n';
const POST_TEXT = [
  SRT_BASE,
  SRT_BASE.replace(/\n/g, '\r\n'),
  '﻿' + SRT_BASE,
  '1\n00:00:01,000 --> 00:00:02,000\n  Hello   world ! . .  \n   \n\n\n\n\n2\n00:00:03,000 --> 00:00:04,000\nWow!!!!!! Really???? ....\n',
  '\n\n\n1\n00:00:01,000 --> 00:00:02,000\n<i>Hi</i> <font color="red">x</font> {\\an8}y\n',
  '1\n00:00:01,000 --> 00:00:02,000\nl am ln the IVIr house, rnuch 0f it. |t was ||ello |ike\n',
  ASS.join('\n'),
  ASS.join('\r\n'),
  ASS.slice(2).join('\n'),
  'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,a,b,c\n',
  'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n',
  'عربي نص\n',
  '',
  '1\n00:00:01,000 --> 00:00:02,000\nTEXT ONE.\nCONTINUES HERE\nANOTHER LINE\n',
  '1\n00:00:00,100 --> 00:00:00,200\n😀 emoji ☀ ✂ 🇫🇷 x‍y\n',
];
const postCases: unknown[] = [];
for (const content of POST_TEXT) {
  for (const fn of ['removeStyleTags', 'removeEmoji', 'fixOcr', 'fixUppercase', 'reverseRtl', 'assToSrt']) {
    postCases.push({ fn, content });
  }
  for (const language of [undefined, 'fr', 'en']) postCases.push({ fn: 'commonFixes', content, language });
  for (const offsetMs of [0, 1500, -3000, -100000, 3600000]) postCases.push({ fn: 'adjustTimes', content, offsetMs });
  for (const [fromFps, toFps] of [[23.976, 25], [25, 23.976], [24, 24], [0, 25], [25, -1], [30, 24]]) {
    postCases.push({ fn: 'changeFrameRate', content, fromFps, toFps });
  }
}

// ---- paths, suffixes, flags ------------------------------------------------------------------
const pathCases: unknown[] = [];
for (const [lang, forced, hi] of [['en', false, false], ['en', true, false], ['fr', false, true], ['fr', true, true]] as const) {
  pathCases.push({ fn: 'sidecarLangSuffix', lang, forced, hi });
}
for (const s of ['en', 'en.forced', 'en.hi', 'eng', 'eng.forced', 'e', 'engl', 'EN', 'en.forced.hi', 'en-US', 'x/../../tmp', '', 'en.', '.en', 'en.cc', 'zh.hi', 'xx.forced']) {
  pathCases.push({ fn: 'assertSafeLangSuffix', suffix: s });
}
for (const [root, stored] of [
  ['/m/Movie', 'Movie.en.srt'], ['/m/Movie', 'sub/Movie.en.srt'], ['/m/Movie', '../x.srt'], ['/m/Movie', '/m/Movie/a.srt'], ['/m/Movie', '/m/Movie2/a.srt'],
  ['/m/Movie/', 'a.srt'], ['/m/Movie', ' a.srt '], ['/m/Movie', ''], ['', 'a.srt'], ['/m/Movie', '   '], ['/m/Movie', '.'], ['/m/Movie', './a/../b.srt'],
  ['/m/Movie', '..foo/a.srt'], ['/m/Movie', 'a/../../Movie/b.srt'], ['/', 'a.srt'], ['/m/Movie', '/m/Movie'], ['/m//Movie', 'a.srt'], ['/m/Movie', 'a//b.srt'],
] as const) {
  pathCases.push({ fn: 'resolveSubtitleAbsolutePath', root, stored });
}
for (const [root, file] of [
  ['/m/Movie', '/m/Movie/a.srt'], ['/m/Movie', '/m/Movie'], ['/m/Movie', '/m/Movie/sub/a.srt'], ['/m/Movie', '/m/Other/a.srt'], ['/m/Movie', '/m/Movie/../a.srt'],
  ['/m/Movie', '/m/Movie/..foo/a.srt'], ['/m/Movie', '/m/Movie/./a.srt'], ['/m/Movie/', '/m/Movie/a.srt'], [' /m/Movie ', '/m/Movie/a.srt'], ['', '/m/Movie/a.srt'], ['/', '/a.srt'],
  ['/m/Movie', '/m/MovieX/a.srt'],
] as const) {
  pathCases.push({ fn: 'relativePathUnderMediaRoot', root, file });
}
for (const name of ['Movie.en.hi.srt', 'Movie.hi.srt', 'Movie.en.cc.forced.srt', 'Movie.sdh.en.srt', 'Movie.en.srt', 'Movie.EN.SDH.SRT', 'Movie.mkv', 'a.b.c.fr.hi.srt', 'Movie.hi.en.srt']) {
  pathCases.push({ fn: 'stripHiFromFilename', name });
}
for (const t of ['en', 'eng', 'fre', 'fra', 'french', 'English', 'en-US', 'pt-br', 'EN-us', 'xx', 'zz', 'zho', 'chi', 'ger', 'deu', 'spanish', 'hin', 'hindi', 'x-y', 'e', 'engl', 'ES', 'xx-yy', 'a-b', 'sp-es']) {
  pathCases.push({ fn: 'resolveLanguageCode', token: t });
}

const MODES = [undefined, 'prefer', 'avoid', 'require', 'forbid', 'bogus'];
const flagCases: unknown[] = [];
for (const forced of [undefined, true, false]) {
  for (const mode of MODES) {
    for (const sf of [false, true]) for (const sh of [false, true]) {
      flagCases.push({ fn: 'matchesRequestedFlags', sub: { forced: sf, hearingImpaired: sh }, req: { forced, hearingImpairedMode: mode } });
    }
    flagCases.push({ fn: 'prefersHearingImpaired', req: { forced, hearingImpairedMode: mode } });
  }
}
for (let i = 0; i < 60; i++) {
  const item = {
    isoCode: pick(rng, ['en', 'fr']),
    name: 'x',
    forced: pick(rng, [true, false]),
    hi: pick(rng, [true, false]),
    ...(rng() < 0.5 ? { hearingImpaired: pick(rng, ['prefer', 'avoid', 'require', 'forbid']) } : {}),
  };
  flagCases.push({ fn: 'requestFlagsOf', item });
  const subs = Array.from({ length: ri(rng, 0, 3) }, () => ({
    language: pick(rng, ['en', 'fr', 'de']),
    forced: pick(rng, [true, false]),
    hearingImpaired: pick(rng, [true, false]),
    codec: pick(rng, ['subrip', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'ass', null]),
    status: pick(rng, ['downloaded', 'failed', 'embedded', 'synced']),
  }));
  flagCases.push({ fn: 'hasCoveringSub', subs, item, imageTracksCount: pick(rng, [true, false]) });
}

const SRTS = [
  '1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\nbye\n',
  '﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n',
  '1\r00:00:01,000 --> 00:00:02,000\rHi\r\r2\r00:00:03,000 --> 00:00:04,000\rBye',
  '1\n00:00:01,000 --> 00:00:02,000\nHi\n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
  '00:00:01,000 --> 00:00:02,000\nHi\n00:00:03,000 --> 00:00:04,000\nBye\n',
  '1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
  '1\n00:00:01,000 --> 00:00:02,000\nHi\n \t \n2\n00:00:03,000 --> 00:00:04,000\nBye\n',
  '', 'no cues here', '12\n00:00:01,000 --> 00:00:02,000\n 99 \n',
];
for (const content of SRTS) pathCases.push({ fn: 'parseSrt', content });
for (const content of SRTS) pathCases.push({ fn: 'srtRoundTrip', content });

function run(i: any): unknown {
  switch (i.fn) {
    case 'cleanSubtitle':
      return cleaner
        .cleanSubtitle(Buffer.from(i.content, 'utf-8'), { removeAds: i.removeAds, removeHiTags: i.removeHiTags, customExclusions: i.customExclusions })
        .toString('utf-8');
    case 'removeStyleTags': case 'removeEmoji': case 'fixOcr': case 'fixUppercase': case 'reverseRtl': case 'assToSrt':
      return (post as any)[i.fn](i.content);
    case 'commonFixes': return post.commonFixes(i.content, i.language);
    case 'adjustTimes': return post.adjustTimes(i.content, i.offsetMs);
    case 'changeFrameRate': return post.changeFrameRate(i.content, i.fromFps, i.toFps);
    case 'sidecarLangSuffix': return sidecarLangSuffix(i.lang, i.forced, i.hi);
    case 'assertSafeLangSuffix':
      try { assertSafeLangSuffix(i.suffix); return true; } catch { return false; }
    case 'resolveSubtitleAbsolutePath': return resolveSubtitleAbsolutePath(i.root, i.stored);
    case 'relativePathUnderMediaRoot': return relativePathUnderMediaRoot(i.root, i.file);
    case 'stripHiFromFilename': return svc.stripHiFromFilename(i.name);
    case 'resolveLanguageCode': return svc.resolveLanguageCode(i.token);
    case 'matchesRequestedFlags': return matchesRequestedFlags(i.sub, i.req);
    case 'prefersHearingImpaired': return prefersHearingImpaired(i.req);
    case 'requestFlagsOf': return requestFlagsOf(i.item);
    case 'hasCoveringSub': return hasCoveringSub(i.subs, i.item, { imageTracksCount: i.imageTracksCount });
    case 'parseSrt': return parseSrt(i.content);
    case 'srtRoundTrip': return serializeSrt(parseSrt(i.content));
  }
  throw new Error(i.fn);
}

emit('subtitle-files', [...cleanerCases, ...postCases, ...pathCases, ...flagCases], run).then(() =>
  console.log(`subtitle-files clean=${cleanerCases.length} post=${postCases.length} path=${pathCases.length} flags=${flagCases.length}`),
);
