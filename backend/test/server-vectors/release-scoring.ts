import {
  allowedAudioLanguageIds,
  appendedSequelNumber,
  buildAllowedQualityIds,
  collectionPackWord,
  computeRejections,
  computeSizeDeviation,
  detectCodecSizeFactor,
  detectVideoCodec,
  indexTitleExpectations,
  maxResolutionFromQualityStrings,
  releaseFlags,
  releaseMatchesMedia,
  releaseTitleTokens,
  releaseYears,
  resolveSearchTitles,
  scoreAndSortReleases,
  sortReleasesByRelevance,
  titleMatchesExpectation,
} from '../../src/common/release-scoring/release-rejection.helper';
import { APP_QUALITIES } from '../../src/common/constants/app-qualities';
import { maybeDiverge, RELEASES } from './_corpus';
import { emit, mulberry32, pick, ri } from './_util';

const rng = mulberry32(0x5c01);
const chance = (p: number) => rng() < p;
const sub = <T>(xs: readonly T[], p = 0.4): T[] => xs.filter(() => chance(p));

// ---- title corpus
const EXPECT: string[] = [
  'Nova Skyline', 'Nova Skyline 2', "Owner's Original Title", "Titre localisé de l'éditeur", 'La voix du succès', 'The', 'A', 'Le Les Des', '2012', 'The Collection',
  '東京 Tokyo Story', '作品タイトル', 'ノヴァ・スカイライン', 'Café', 'Æon Flux', 'Straße', 'Tom & Jerry', 'Nova.Skyline', 'ŒUVRE', 'İstanbul', 'Σίσυφος', 'Mr. Robot',
  'Spider-Man 3', 'Rocky IV', 'Rocky', 'Ocean’s Eleven', "Ocean's Eleven", 'Oceanʼs 11', '', ' ', 'L’éditeur', 'D’artagnan', 'Blade Runner 2049', 'Final Destination 5',
  'Ｎｏｖａ Ｓｋｙｌｉｎｅ', 'Original Movie Title', 'Original Show Title', 'Other Series', 'Show', 'Movie', 'The Movie', '10 Things', 'Se7en', 'Ørkenen', 'Привет мир', 'Hello World 99',
  'Nova Skyline II', 'Les Misérables', 'Amélie', 'Nova Skyline: The Beginning', 'K', 'ǅ', 'ß', 'Ⅳ Rocky', 'ｆｕｌｌｗｉｄｔｈ',
];
const SUFFIX = ['', '.2', '.II', '.3', '.IV', '.10', '.99', '.1', '.Collection', '.Trilogy', '.Saga', '.Filmography', '.2015', '.2012', '.2013', '.2014', '.(2010-2015)', '.S01E02', '.2.2015', '.Duology', '.Anthology', '.ix', '.vi', '.v', '.x', '.100', '.0', '.02'];
const TAILS = ['', '.1080p.BluRay.x264-GRP', '.720p.HDTV', '.MULTI.VF.1080p', '.S04E03.1080p.WEB-DL', '.2160p.HDR10.DDP5.1.x265'];
const stripAccents = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function releaseFor(expected: string): string {
  let base = expected;
  switch (ri(rng, 0, 6)) {
    case 0: base = base.replace(/ /g, '.'); break;
    case 1: base = stripAccents(base).replace(/['’ʼ]/g, '').replace(/[ :]/g, '.'); break;
    case 2: base = stripAccents(base).replace(/['’ʼ]/g, '.').replace(/ /g, '.'); break;
    case 3: base = base.replace(/ /g, ' ').toUpperCase(); break;
    case 4: base = base.replace(/ /g, '_'); break;
    case 5: base = pick(rng, EXPECT).replace(/ /g, '.'); break;
    default: break;
  }
  return maybeDiverge(rng, `${chance(0.15) ? 'Prefix.' : ''}${base}${pick(rng, SUFFIX)}${pick(rng, TAILS)}`, 0.1);
}
const expectedList = (): string | string[] => {
  const r = rng();
  if (r < 0.3) return pick(rng, EXPECT);
  if (r < 0.35) return [];
  return Array.from({ length: ri(rng, 1, 3) }, () => pick(rng, EXPECT));
};
const media = () => ({
  title: pick(rng, EXPECT),
  originalTitle: chance(0.3) ? undefined : chance(0.1) ? null : pick(rng, EXPECT),
  alternativeTitles: chance(0.4) ? undefined : chance(0.1) ? null : Array.from({ length: ri(rng, 0, 3) }, () => pick(rng, EXPECT)),
  year: chance(0.3) ? null : ri(rng, 2010, 2016),
});

const idx = (expected: string | string[]) => ({ fn: 'indexTitleExpectations', expected });
const tme = (releaseTitle: string, expected: string | string[], whenUnreadable?: string) => ({ fn: 'titleMatchesExpectation', releaseTitle, expected, whenUnreadable });
const rtm = (releaseTitle: string, m: object, requireYearInTitle?: boolean) => ({ fn: 'releaseMatchesMedia', releaseTitle, media: m, requireYearInTitle });
const rst = (m: object, customQuery?: string) => ({ fn: 'resolveSearchTitles', media: m, customQuery });

// release-rejection.helper.spec.ts: resolveSearchTitles, titleMatchesExpectation, releaseMatchesMedia
const movie = { title: 'Titre localisé', originalTitle: 'Original Movie Title', year: 2004, alternativeTitles: null };
const nonLatinAlt = { title: 'Original Movie Title', originalTitle: 'Original Movie Title', year: 1985, alternativeTitles: ['作品タイトル', 'Original Movie Title'] };
const localizedShow = { title: 'Série localisée', originalTitle: 'Original Show Title', alternativeTitles: null };
const possessive = { title: "Titre localisé de l'éditeur", originalTitle: "Owner's Original Title", alternativeTitles: null };
const jaShow = { originalTitle: 'ノヴァ・スカイライン', title: 'ノヴァ・スカイライン', alternativeTitles: ['Nova Skyline'] };
const titleSpec: unknown[] = [
  rtm('Other.Movie.2004.2160p.UHD.BluRay.x265-GROUP', movie, true), rtm('Original.Movie.Title.2004.1080p.WEB-DL.x264-GROUP', movie, true),
  rtm('Unrelated.Other.Film.1985.1080p.BluRay.x264-GROUP', nonLatinAlt, true), rtm('Original.Movie.Title.1985.1080p.BluRay.x264-GROUP', nonLatinAlt, true),
  rtm('Original.Movie.Title.1985.1080p.BluRay.x264-GROUP', nonLatinAlt, false), rtm('Original.Movie.Title.1986.1080p.BluRay.x264-GROUP', nonLatinAlt),
  rst(localizedShow), rst(possessive), rst(jaShow), rst({ ...jaShow, alternativeTitles: [] }), rst(movie, '  custom query  '), rst(movie, '   '), rst(movie, ''),
  tme('Original.Show.Title.S09E04.1080p.WEB-DL.x264-GROUP', ['Original Show Title', 'Série localisée']), tme('Other.Series.S05E10.1080p.x264-GROUP', ['Original Show Title', 'Série localisée']),
  tme('Owners.Original.Title.S01E04.1080p.HDTV.x264-GROUP', ["Owner's Original Title", "Titre localisé de l'éditeur"]),
  tme('Owners.Original.Title.S01E04.MULTI.VF.1080p.HDTV-GROUP', ["Owner's Original Title", "Titre localisé de l'éditeur"]),
  tme('Titre.localise.de.l.editeur.S01E04.AD.HDTV.x264-GROUP', ["Owner's Original Title", "Titre localisé de l'éditeur"]),
  tme('Unrelated.Other.Film.1985.1080p.x264-GROUP', ['Original Movie Title', '作品タイトル']), tme('Anything.1985.1080p.x264-GROUP', ['作品タイトル', '作品'], 'no-match'),
  tme('Anything.1985.1080p.x264-GROUP', ['作品タイトル', '作品']), tme('Tokyo.Story.S01E01.1080p.WEB-DL.x264-GROUP', ['東京 Tokyo Story']),
].flatMap((c: any) => (c.fn === 'titleMatchesExpectation' && c.whenUnreadable === undefined ? [c, { ...c, whenUnreadable: 'no-match' }] : [c]));
titleSpec.push(
  ...['Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', 'Nova.Skyline.Collection.(2012-2017).MULTi.1080p.BluRay.x264-GRP', 'Nova.Skyline.2012.1080p.BluRay.DD.7.1.x265-GRP'].flatMap((t) => [
    { fn: 'appendedSequelNumber', releaseTitle: t, expected: ['Nova Skyline', 'La voix du succès'] },
    { fn: 'collectionPackWord', releaseTitle: t, expected: ['Nova Skyline', 'La voix du succès'] },
    { fn: 'releaseYears', title: t },
    { fn: 'releaseTitleTokens', title: t },
  ]),
  { fn: 'appendedSequelNumber', releaseTitle: 'Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', expected: ['Nova Skyline 2'] },
  { fn: 'collectionPackWord', releaseTitle: 'The.Collection.2012.1080p', expected: ['The Collection'] },
  { fn: 'releaseYears', title: '2012.2009.1080p.BluRay' },
);

// generated: title functions
const titleGen: unknown[] = [];
for (let i = 0; i < 600; i++) {
  const expected = expectedList();
  const list = Array.isArray(expected) ? expected : [expected];
  const rel = releaseFor(list.length ? pick(rng, list) || 'X' : 'X');
  const rel2 = chance(0.15) ? pick(rng, RELEASES) : rel;
  switch (i % 10) {
    case 0: titleGen.push(idx(expected)); break;
    case 1: case 2: titleGen.push(tme(rel2, expected, pick(rng, [undefined, 'match', 'no-match']))); break;
    case 3: titleGen.push({ fn: 'releaseTitleTokens', title: rel2 }); break;
    case 4: case 5: titleGen.push({ fn: 'appendedSequelNumber', releaseTitle: rel2, expected }); break;
    case 6: titleGen.push({ fn: 'collectionPackWord', releaseTitle: rel2, expected }); break;
    case 7: titleGen.push({ fn: 'releaseYears', title: rel2 }); break;
    case 8: titleGen.push(rst(media(), chance(0.2) ? pick(rng, ['', ' ', 'custom', ' Nova Skyline ']) : undefined)); break;
    default: { const m = media(); titleGen.push(rtm(releaseFor(m.title || 'X'), m, pick(rng, [undefined, true, false]))); }
  }
}

// ---- computeRejections
const baseOpts = () => ({
  qualityId: 1, allowed: [1], languageId: 1, allowedLangs: [] as number[], isBlocklisted: false, sizeBytes: 0, runtimeMinutes: 112,
  sizeByQuality: [] as unknown[], seeders: 10, sourceId: 0, sourceMinSeeders: [] as unknown[],
});
const rej = (over: object) => ({ fn: 'computeRejections', opts: { ...baseOpts(), ...over } });
const specRej: unknown[] = [];
const rr = (releaseTitle: string, over: object = {}) => specRej.push(rej({ releaseTitle, ...over }));
const NS = ['Nova Skyline', 'La voix du succès'];
for (const t of ['Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', 'Nova.Skyline.Collection.(2012-2017).MULTi.1080p.BluRay.x264-GRP', 'Nova.Skyline.2012.1080p.BluRay.DD.7.1.x265-GRP', 'Nova Skyline (2012) 1080p BrRip x264 GRP',
  'Nova-Skyline-(2012)[1080p-BDRip--Original-Auds-]', 'La.voix.du.succes.(2012).[1080p].MULTI.VF2.Bluray.x264-GRP', 'Nova.Skyline.2012.UNRATED.1080p', 'Nova.Skyline.1080p.BluRay.x264-GRP',
  'Nova.Skyline.2013.1080p.BluRay', 'Nova.Skyline.2014.1080p.BluRay', 'Nova.Skyline.2012.2160p.x264.DDP5.1.HDR10', 'Other.Show.2.2015.1080p']) rr(t, { expectedTitle: NS, expectedYear: 2012, runtimeMinutes: 112 });
rr('Nova.Skyline.2.2015.1080p.BluRay.x264-GRP', { expectedTitle: ['Nova Skyline 2'], expectedYear: 2015 });
rr('Nova.Skyline.2012.1080p.BluRay', { expectedTitle: ['Nova Skyline 2'], expectedYear: 2015 });
rr('2012.2009.1080p.BluRay', { expectedTitle: ['2012'], expectedYear: 2009 });
rr('The.Collection.2012.1080p', { expectedTitle: ['The Collection'], expectedYear: 2012 });
rr('Nova.Skyline.Complete.Collection.1080p', { expectedTitle: ['Nova Skyline'], expectedYear: null, expectedSeason: 4 });
for (const [t, s, e] of [['Some.Show.S04E02.1080p.WEB-DL.x264', 4, 3], ['Some.Show.S04E03.1080p.WEB-DL.x264', 4, 3], ['Some.Show.S04.COMPLETE.1080p.WEB-DL', 4, 3], ['Some.Show.S04.COMPLETE.1080p.WEB-DL', 4, undefined],
  ['Some.Show.S03.COMPLETE.1080p.WEB-DL', 4, 3], ['Some.Show.S01-S04.1080p.WEB-DL', 2, undefined], ['Some.Show.S01-S04.1080p.WEB-DL', 5, undefined], ['Some.Show.S01-S04.1080p.WEB-DL', 2, 3],
  ['Some.Show.S04E02E03.1080p.WEB-DL', 4, 3], ['Some.Show.S04E02-E03.1080p.WEB-DL', 4, 2], ['Some.Show.S04E02E03.1080p.WEB-DL', 4, 4], ['Some.Show.Complete.Series.1080p', 2, undefined],
  ['Some.Show.Complete.Series.1080p', 2, 3], ['Some.Show.S01-S04.1080p', 9, 9], ['Some.Show.S01E04-E05.1080p', 9, 9], ['Some.Show.1080p.WEB-DL.x264', 4, 3], ['Some.Show.S04E02.1080p.WEB-DL.x264', undefined, undefined]] as const)
  rr(t, { runtimeMinutes: 30, expectedSeason: s, expectedEpisode: e });
for (const [t, min] of [['Show.S01E01.1080p.BluRay.x264', 1080], ['Show.S01E01.2160p.WEB-DL.x265', 1080], ['Show.S01E01.720p.WEB-DL.x264', 1080], ['Show.S01E01.1080p.BluRay.x264', 0], ['Show.S01E01.1080p.BluRay.x264', undefined]] as const)
  rr(t, { qualityId: 9, allowed: [9], runtimeMinutes: 0, minResolution: min });
for (const [q, al] of [[16, [16, 18]], [19, [16, 18]], [12, [16, 18]], [16, []]] as const) specRej.push(rej({ qualityId: q, allowed: al }));
for (const [s, m] of [[-50, 0], [0, 0], [10, 50], [-9999, undefined]] as const) specRej.push(rej({ customFormatScore: s, minCustomFormatScore: m }));
for (const [r, a, b] of [[62, 62, 100], [61, 62, 100], [63, 62, 100], [101, 0, 100], [100, 0, 100], [101, 0, Number.POSITIVE_INFINITY], [1, undefined, undefined]] as const)
  specRej.push(rej({ rank: r, minRankExclusive: a, maxRankInclusive: b }));
rr('Other.Show.S01E01.1080p.WEB', { runtimeMinutes: 24, expectedTitle: ['ノヴァ・スカイライン'] });
rr('[Grp] Nova Skyline | ノヴァ・スカイライン - 01 [1080p]', { runtimeMinutes: 24, expectedTitle: ['ノヴァ・スカイライン'] });
rr('Anything', { expectedTitle: [] }); rr('Anything', { expectedTitle: '' }); rr('Anything', { expectedTitle: ' ' }); rr('', { expectedTitle: 'Nova Skyline' }); rr('Nova.Skyline', { expectedTitle: 'Nova Skyline' });

const LIMITS = [{ min: 0, preferred: 0, max: 0 }, { min: 500, preferred: 2000, max: 6000 }, { min: 100, preferred: 500, max: 1500 }, { min: 3000, preferred: 8000, max: 20000 }, { min: 0, preferred: 4000, max: 9000 }];
function randomOpts(): Record<string, unknown> {
  const qualityId = pick(rng, [1, 2, 5, 8, 11, 12, 15, 16, 17, 18, 19, 20, 23, 24]);
  const o: Record<string, unknown> = {
    qualityId,
    allowed: sub([1, 2, 5, 8, 11, 12, 15, 16, 17, 18, 19, 20, 23, 24], 0.5),
    languageId: pick(rng, [1, 2, 3, 99]),
    allowedLangs: chance(0.6) ? [] : sub([1, 2, 3, 99], 0.5),
    isBlocklisted: chance(0.12),
    sizeBytes: pick(rng, [0, 1e8, 1.5e9, 3e9, 8e9, 5e10, -5, 4.5e8]),
    runtimeMinutes: pick(rng, [0, 24, 45, 112, 180, -1]),
    sizeByQuality: chance(0.7) ? [[qualityId, pick(rng, LIMITS)]] : [],
    seeders: pick(rng, [0, 1, 2, 5, 100]),
    sourceId: pick(rng, [0, 1, 2]),
    sourceMinSeeders: sub([[0, 3], [1, 0], [2, 20]], 0.5),
  };
  const put = (k: string, v: unknown, p = 0.5) => { if (chance(p)) o[k] = v; };
  put('releaseTitle', pick(rng, [...RELEASES, '', null as unknown as string, 'Nova.Skyline.2.2015.1080p', 'Nova.Skyline.Collection.1080p.BluRay.x265', 'Nova Skyline S04E03 720p']), 0.9);
  put('coverage', pick(rng, [null, { seasons: { from: 1, to: 4 }, episodes: null, completeSeries: false }, { seasons: { from: 2, to: 2 }, episodes: { from: 3, to: 5 }, completeSeries: false }, { seasons: null, episodes: null, completeSeries: true }]), 0.15);
  put('expectedTitle', pick(rng, ['Nova Skyline', ['Nova Skyline', 'La voix du succès'], '', [], 'The Movie', ['Show'], ['作品タイトル'], 'Éclair', 'Original Movie Title', 'Nova Skyline 2']), 0.5);
  put('expectedSeason', pick(rng, [1, 2, 4, null, 100]), 0.35);
  put('expectedEpisode', pick(rng, [1, 3, 5, null, 0]), 0.3);
  put('minResolution', pick(rng, [0, 480, 720, 1080, 2160, null]), 0.3);
  put('expectedYear', pick(rng, [2012, 2019, 2020, 2015, 0, null, 1999]), 0.4);
  put('customFormatScore', pick(rng, [-100, -1, 0, 5, 100]), 0.4);
  put('minCustomFormatScore', pick(rng, [-50, 0, 10, 100, null]), 0.4);
  put('rank', pick(rng, [5, 40, 62, 68, 95]), 0.5);
  put('minRankExclusive', pick(rng, [0, 40, 62, 90]), 0.4);
  put('maxRankInclusive', pick(rng, [50, 68, 100, null]), 0.4);
  return o;
}
const CODES = ['TITLE_MISMATCH', 'SEQUEL_MISMATCH', 'COLLECTION_PACK', 'YEAR_MISMATCH', 'EPISODE_MISMATCH', 'FULL_SEASON_FOR_EPISODE', 'QUALITY_NOT_ALLOWED', 'CUSTOM_FORMAT_SCORE_TOO_LOW', 'RANK_NOT_AN_UPGRADE', 'RANK_ABOVE_CUTOFF', 'RESOLUTION_NOT_UPGRADED', 'LANGUAGE_NOT_ALLOWED', 'BLOCKLISTED', 'SIZE_TOO_LOW', 'SIZE_TOO_HIGH', 'MIN_SEEDERS'];
const pool = Array.from({ length: 12000 }, () => ({ fn: 'computeRejections', opts: randomOpts() }));
const poolCodes = pool.map((c) => computeRejections(toOpts(c.opts)).map((r) => r.code));
const rejGen: unknown[] = [];
const seen = new Map<string, number>();
const used = new Set<number>();
for (const code of CODES) {
  for (let i = 0; i < pool.length && (seen.get(code) ?? 0) < 20; i++) {
    if (!used.has(i) && poolCodes[i].includes(code)) { used.add(i); rejGen.push(pool[i]); for (const c of poolCodes[i]) seen.set(c, (seen.get(c) ?? 0) + 1); }
  }
}
for (let i = 0; rejGen.length < 1500 - specRej.length; i++) if (!used.has(i)) { used.add(i); rejGen.push(pool[i]); }

// ---- sort
const row = (id: string, over: object = {}) => ({ id, qualityId: 16, rank: 100, allowed: true, blocklisted: false, languageAllowed: true, rejections: [], customFormatScore: 0, seeders: 10, leechers: 0, flags: [], sizeDeviation: 0, ...over });
const span = (from: number, to: number) => ({ seasons: { from, to }, episodes: null, completeSeries: false });
const sortCase = (rows: object[], preferFullSeason?: boolean) => ({ fn: 'sortReleasesByRelevance', rows, preferFullSeason });
const sortSpec: unknown[] = [
  sortCase([row('S01-S04', { isFullSeason: true, seeders: 500, coverage: span(1, 4) }), row('S02', { isFullSeason: true, seeders: 10, coverage: span(2, 2) })], true),
  sortCase([row('dead-1080p', { rank: 200, seeders: 0 }), row('live-720p', { rank: 100, seeders: 5 })]),
  sortCase([row('freeleech', { flags: ['freeleech'] }), row('scored', { customFormatScore: 100 })]),
  sortCase([row('freeleech', { flags: ['freeleech'], customFormatScore: 100 }), row('paid', { customFormatScore: 100 })]),
  sortCase([row('sd', { rank: 100, seeders: 500 }), row('hd', { rank: 200, seeders: 5 })]),
  sortCase([row('few', { seeders: 5, sizeDeviation: 0 }), row('many', { seeders: 200, sizeDeviation: 0.4 })]),
  sortCase([row('quiet', { seeders: 100, leechers: 1 }), row('busy', { seeders: 100, leechers: 80 })]),
  sortCase([row('rejected', { rank: 300, seeders: 999, rejections: [{ code: 'QUALITY_NOT_ALLOWED' }] }), row('clean', { rank: 100, seeders: 1 })]),
  sortCase([row('single', { seeders: 5000 }), row('pack', { isFullSeason: true, seeders: 20 })], true),
  sortCase([row('pack-720p', { isFullSeason: true, qualityId: 12, rank: 100 }), row('single-1080p', { qualityId: 16, rank: 200 })], true),
  sortCase([row('single-webdl', { qualityId: 16, rank: 62 }), row('pack-webrip', { isFullSeason: true, qualityId: 17, rank: 60 })], true),
  sortCase([row('single', { seeders: 5000 }), row('pack', { isFullSeason: true, seeders: 20 })]),
  sortCase([]), sortCase([row('only')]),
];
const GRID = [0, 1, 5, 20, 100, 500];
const DEV = [0, 0.1, 0.25, 0.5, 1];
const FLAGSET = [[], ['freeleech'], ['halfleech'], ['internal', 'freeleech']];
const SPAN = [span(1, 1), span(2, 2), span(1, 4), span(3, 3), span(1, 2)];
function genRows(n: number, real: boolean): object[] {
  const nullDev = chance(0.3);
  return Array.from({ length: n }, (_, i) => {
    const q = pick(rng, APP_QUALITIES);
    const pack = chance(0.4);
    return row(`r${i}`, {
      qualityId: q.id, rank: real ? q.rank : pick(rng, [5, 40, 62, 68, 95, 100]), allowed: chance(0.9), blocklisted: chance(0.1), languageAllowed: chance(0.9),
      rejections: chance(0.12) ? [{ code: 'QUALITY_NOT_ALLOWED' }] : [], customFormatScore: pick(rng, [-100, 0, 0, 5, 100]), seeders: pick(rng, GRID), leechers: pick(rng, GRID),
      flags: pick(rng, FLAGSET), sizeDeviation: nullDev ? null : pick(rng, DEV), isFullSeason: pack, coverage: pack ? pick(rng, SPAN) : undefined,
    });
  });
}

// the comparator's relation, read back through 2-row sorts (stable, so a tie keeps the input order)
function isTotalPreorder(rows: any[], prefer: boolean): boolean {
  const n = rows.length;
  const lt = (a: any, b: any) => { const out = sortReleasesByRelevance([b, a], { preferFullSeason: prefer }); return out[0] === a && out[1] === b; };
  const L = rows.map((a) => rows.map((b) => (a === b ? false : lt(a, b))));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) continue;
    if (L[i][j] && L[j][i]) return false;
    for (let k = 0; k < n; k++) {
      if (k === i || k === j) continue;
      if (L[i][j] && L[j][k] && !L[i][k]) return false;
      const eq = (a: number, b: number) => !L[a][b] && !L[b][a];
      if (eq(i, j) && eq(j, k) && !eq(i, k)) return false;
    }
  }
  return true;
}
const sortGen: unknown[] = [];
let exact = 0;
while (exact < 400) {
  const rows = genRows(ri(rng, 2, 40), chance(0.85));
  const prefer = chance(0.5);
  if (!isTotalPreorder(rows, prefer)) continue;
  exact++;
  sortGen.push(sortCase(rows, prefer));
}
// intransitive sets: the epsilon chain and the pack/loose cycle of the spec
for (let i = 0; i < 20; i++) {
  const rows = [
    row('pack55', { qualityId: 16, rank: 55, isFullSeason: true, coverage: span(1, 1) }), row('loose68', { qualityId: 16, rank: 68 }), row('loose60', { qualityId: 11, rank: 60 }),
    row('s10', { seeders: 10, rank: 1 }), row('s12', { seeders: 12, rank: 1 }), row('s14', { seeders: 14, rank: 1 }), ...genRows(ri(rng, 0, 6), true).map((r: any) => ({ ...r, id: `x${r.id}` })),
  ].sort(() => rng() - 0.5);
  sortGen.push({ ...sortCase(rows, true), order: 'unspecified' });
}

// ---- scoreAndSortReleases
const scoreGen: unknown[] = [];
const SIZES = [0, 5e8, 1e9, 2.2e9, 4.4e9, 9e9, 3e10];
for (let i = 0; scoreGen.length < 150; i++) {
  const releases = Array.from({ length: ri(rng, 1, 10) }, (_, k) => ({
    title: pick(rng, RELEASES), downloadUrl: `https://t.example/${i}/${k}`, sourceId: pick(rng, [0, 1, 2]), sourceName: 'src', size: pick(rng, SIZES), seeders: pick(rng, GRID), leechers: pick(rng, GRID),
    publishDate: chance(0.5) ? '2024-01-02T03:04:05Z' : null, flags: pick(rng, FLAGSET),
  }));
  const o: any = randomOpts();
  const opts: Record<string, unknown> = {
    allowed: o.allowed, allowedLangs: o.allowedLangs, sizeByQuality: [[16, pick(rng, LIMITS)], [18, pick(rng, LIMITS)], [11, pick(rng, LIMITS)]], sourceMinSeeders: o.sourceMinSeeders,
    sourceUnknownLang: sub([[0, 'fr'], [1, null], [2, 'xx'], [3, 'de']], 0.5), runtimeMinutes: o.runtimeMinutes,
  };
  for (const k of ['expectedTitle', 'expectedSeason', 'expectedEpisode', 'minResolution', 'expectedYear', 'minCustomFormatScore', 'minRankExclusive', 'maxRankInclusive']) if (k in o) opts[k] = o[k];
  const customFormatScores: Record<string, number> = {};
  for (const r of releases) if (chance(0.4)) customFormatScores[r.title] = pick(rng, [-100, 0, 5, 100]);
  const blocked = releases.filter(() => chance(0.1)).map((r) => [r.title, r.sourceId]);
  scoreGen.push({ fn: 'scoreAndSortReleases', releases, opts, customFormatScores, blocked });
}

// ---- helpers
const helperGen: unknown[] = [];
const TITLES2 = [...RELEASES, '', 'x265 only', 'H 264', 'h-265', 'H.264', 'H264', 'AV1.HDR', 'VP9', 'AVC', 'HEVC', 'x264-HEVC', 'Movie.AV1.x265'];
for (let i = 0; i < 300; i++) {
  switch (i % 8) {
    case 0: helperGen.push({ fn: 'computeSizeDeviation', title: pick(rng, TITLES2), sizeBytes: pick(rng, [0, -1, 1e8, 2e9, 8e9]), runtimeMinutes: pick(rng, [0, -5, 24, 112]), limits: chance(0.15) ? undefined : pick(rng, LIMITS) }); break;
    case 1: helperGen.push({ fn: 'detectCodecSizeFactor', title: chance(0.1) ? undefined : pick(rng, TITLES2) }); break;
    case 2: helperGen.push({ fn: 'detectVideoCodec', title: chance(0.1) ? undefined : pick(rng, TITLES2) }); break;
    case 3: helperGen.push({ fn: 'buildAllowedQualityIds', items: chance(0.1) ? undefined : Array.from({ length: ri(rng, 0, 10) }, (_, k) => ({ quality: { id: ri(rng, 1, 24) }, allowed: chance(0.4), sortOrder: k, ...(chance(0.5) ? { groupId: ri(rng, 1, 3) } : {}) })) }); break;
    case 4: helperGen.push({ fn: 'allowedAudioLanguageIds', items: chance(0.1) ? undefined : Array.from({ length: ri(rng, 0, 5) }, () => ({ isoCode: pick(rng, ['en', 'fr', 'xx', 'zz', 'de', '', 'ja']), name: 'n' })) }); break;
    case 5: helperGen.push({ fn: 'releaseFlags', source: { ...(chance(0.7) ? { flags: sub(['freeleech', 'internal', 'halfleech', 'freeleech', 'x'], 0.5) } : {}), ...(chance(0.5) ? { freeleech: chance(0.5) } : {}), ...(chance(0.6) ? { downloadVolumeFactor: pick(rng, [0, 0.5, 1, 0.25, -0.0]) } : {}) } }); break;
    case 6: helperGen.push({ fn: 'maxResolutionFromQualityStrings', files: Array.from({ length: ri(rng, 0, 4) }, () => pick(rng, [{}, { quality: null }, { quality: '' }, { quality: 'Bluray-1080p' }, { quality: 'WEBDL-720p' }, { quality: 'Remux-2160p' }, { quality: 'junk' }, { quality: 'HDTV-720p' }])) }); break;
    default: helperGen.push({ fn: 'detectVideoCodec', title: pick(rng, TITLES2) });
  }
}

// ---- runner
function toOpts(o: any): any {
  return {
    ...o,
    allowed: new Set(o.allowed), allowedLangs: new Set(o.allowedLangs), sizeByQuality: new Map(o.sizeByQuality), sourceMinSeeders: new Map(o.sourceMinSeeders),
    sourceUnknownLang: o.sourceUnknownLang ? new Map(o.sourceUnknownLang.map(([k, v]: [number, string | null]) => [k, v ?? undefined])) : undefined,
  };
}
const sortedSet = (s: Iterable<unknown>) => [...s].sort();
function run(i: any): unknown {
  switch (i.fn) {
    case 'computeRejections': return computeRejections(toOpts(i.opts));
    case 'sortReleasesByRelevance': {
      const out = sortReleasesByRelevance([...i.rows], { preferFullSeason: i.preferFullSeason }).map((r: any) => r.id);
      return i.order === 'unspecified' ? [...out].sort() : out;
    }
    case 'scoreAndSortReleases': {
      const deps = {
        scoreCustomFormats: async (title: string) => i.customFormatScores[title] ?? 0,
        isBlocked: async (title: string, sourceId: number) => i.blocked.some(([t, s]: [string, number]) => t === title && s === sourceId),
      };
      return scoreAndSortReleases(i.releases, toOpts(i.opts), deps).then((out: any[]) =>
        i.order === 'unspecified' ? [...out].sort((a, b) => (a.downloadUrl < b.downloadUrl ? -1 : 1)) : out,
      );
    }
    case 'indexTitleExpectations': { const x = indexTitleExpectations(i.expected); return { ...x, numbers: sortedSet(x.numbers) }; }
    case 'titleMatchesExpectation': return titleMatchesExpectation(i.releaseTitle, i.expected, i.whenUnreadable);
    case 'releaseTitleTokens': return sortedSet(releaseTitleTokens(i.title));
    case 'appendedSequelNumber': return appendedSequelNumber(i.releaseTitle, indexTitleExpectations(i.expected));
    case 'collectionPackWord': return collectionPackWord(i.releaseTitle, indexTitleExpectations(i.expected));
    case 'releaseYears': return releaseYears(i.title);
    case 'resolveSearchTitles': return resolveSearchTitles(i.media, i.customQuery);
    case 'releaseMatchesMedia': return releaseMatchesMedia(i.releaseTitle, i.media, i.requireYearInTitle === undefined ? undefined : { requireYearInTitle: i.requireYearInTitle });
    case 'computeSizeDeviation': return computeSizeDeviation(i.title, i.sizeBytes, i.runtimeMinutes, i.limits);
    case 'detectCodecSizeFactor': return detectCodecSizeFactor(i.title);
    case 'detectVideoCodec': return detectVideoCodec(i.title);
    case 'buildAllowedQualityIds': return sortedSet(buildAllowedQualityIds(i.items)).sort((a: any, b: any) => a - b);
    case 'allowedAudioLanguageIds': return sortedSet(allowedAudioLanguageIds(i.items)).sort((a: any, b: any) => a - b);
    case 'releaseFlags': return releaseFlags(i.source);
    default: return maxResolutionFromQualityStrings(i.files);
  }
}

(async () => {
  // scoreAndSort sets whose sorted output is not a total preorder are recorded as unspecified
  const scored: unknown[] = [];
  for (const c of scoreGen as any[]) {
    const input = JSON.parse(JSON.stringify(c));
    const out: any[] = (await run(input)) as any[];
    const prefer = input.opts.expectedSeason != null && input.opts.expectedEpisode == null;
    scored.push(isTotalPreorder(out, prefer) ? c : { ...c, order: 'unspecified' });
  }
  const all = [...titleSpec, ...titleGen, ...specRej, ...rejGen, ...sortSpec, ...sortGen, ...scored, ...helperGen];
  await emit('release-scoring', all, run);
  const codes = new Map<string, number>();
  for (const c of [...specRej, ...rejGen] as any[]) for (const r of computeRejections(toOpts(JSON.parse(JSON.stringify(c)).opts))) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
  console.log(`release-scoring total=${all.length} title=${titleSpec.length}+${titleGen.length} rej=${specRej.length}+${rejGen.length} sort=${sortSpec.length}+${sortGen.length} score=${scored.length} (unspecified ${(scored as any[]).filter((c) => c.order).length}) helpers=${helperGen.length}`);
  console.log([...codes].map(([k, v]) => `${k}:${v}`).join(' '));
})();
