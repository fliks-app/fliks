import { NamingService } from '../../src/modules/scheduler/naming.service';
import { maybeDiverge } from './_corpus';
import { emit, mulberry32, pick, ri } from './_util';

const rng = mulberry32(0x4a31);
const chance = (p: number) => rng() < p;

const gf = (rows: object[]) => ({ fn: 'getFormats', rows });
const fmt = (fn: string, format: string, data: unknown) => ({ fn, format, data });
const group = (title: string) => ({ fn: 'extractReleaseGroup', title });
const pen = (title: string, filePath?: string) => ({ fn: 'parseEpisodeNumbers', title, filePath });
const special = (path: string) => ({ fn: 'isSpecialFile', path });
const msbt = (filename: string, specials: object[]) => ({ fn: 'matchSpecialByTitle', filename, specials });

const DEF_MOVIE = '{Movie Title} ({Release Year}) {Quality Full}';
const DEF_SERIES = '{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Quality Full}';
const spec: unknown[] = [
  fmt('applyMovieFormat', DEF_MOVIE, { title: 'Nova Skyline', year: 2023, quality: '1080p' }), fmt('applyMovieFormat', DEF_MOVIE, { title: 'Nova Skyline', year: null, quality: '1080p' }),
  fmt('applyMovieFormat', DEF_MOVIE, { title: 'Nova Skyline', year: 2023, quality: '' }), fmt('applyMovieFormat', '{Movie Title}', { title: '', quality: '' }),
  fmt('applyMovieFormat', '{Original Title}', { title: 'Nova Skyline', originalTitle: 'Orig Nova', quality: '' }), fmt('applyMovieFormat', '{Original Title}', { title: 'Nova Skyline', quality: '' }),
  fmt('applyMovieFormat', '{Release Year}', { title: 'x', year: 0, quality: '' }), fmt('applyMovieFormat', '{Quality Full} {Quality Title}', { title: 'x', quality: '720p' }),
  fmt('applyMovieFormat', '{Release Group}', { title: 'x', quality: '', releaseGroup: 'RELGRP' }), fmt('applyMovieFormat', '{TMDB Id}', { title: 'x', quality: '', tmdbId: 12345 }),
  fmt('applyMovieFormat', '{TMDB Id}', { title: 'x', quality: '', tmdbId: 0 }), fmt('applyMovieFormat', '{Movie Title} [{MediaInfo VideoCodec} {MediaInfo AudioCodec}]', { title: 'Nova Skyline', quality: '' }),
  fmt('applyMovieFormat', '{Movie Title} {Unknown Token}', { title: 'Nova Skyline', quality: '' }), fmt('applyMovieFormat', '{Movie Title}', { title: 'Nova Skyline: Requiem', quality: '' }),
  fmt('applyMovieFormat', '{Movie Title}', { title: 'Nova / Skyline', quality: '' }), fmt('applyMovieFormat', '{Movie Title}', { title: 'Nova Skyline.', quality: '' }),
  fmt('applyMovieFormat', '{Movie Title} undefined', { title: 'Nova Skyline', quality: '' }),
  fmt('applySeriesFormat', DEF_SERIES, { seriesTitle: 'Nova Skyline', season: 1, episode: 2, episodeTitle: 'Pilot Run', quality: '720p' }),
  fmt('applySeriesFormat', DEF_SERIES, { seriesTitle: 'Nova Skyline', season: 1, episode: 2, quality: '720p' }),
  fmt('applySeriesFormat', '{season:00}x{episode:00} {Air Date}', { seriesTitle: 'x', season: 100, episode: -1, quality: '', airDate: '2020-01-02' }),
  fmt('applyMovieFolderFormat', '{Movie Title} ({Release Year})', { title: 'Nova Skyline', year: 2023 }), fmt('applySeriesFolderFormat', '{Series Title}', { seriesTitle: 'Nova Skyline' }),
  fmt('applySeasonFolderFormat', 'Season {season:00}', { season: 3 }), fmt('applySeasonFolderFormat', 'S{season}', { season: 12 }),
  gf([]), gf([{ key: 'naming_movie_format', value: 'X' }]), gf([{ key: 'naming_movie_format', value: null }]),
  ...['Show.S01E02.1080p.WEBDL-1080p.mkv', 'Show.S01E02.1080p-GRP', 'Show.S01E02-GRP.MKV', 'no dash', 'a-b-c', 'x_y-Z_1', 'Movie-GRP.x264'].map(group),
  ...['Show.S01E05.1080p', 'Show.S01E01-E03', 'Show.S01E01E02E04', 'Show.S01E05_06', 'Show 1x05', 'Title 103', 'Show Part 3', 'Show Episode 3', '[Grp] Show - 03 [1080p]', 'Show.E03.720p', 'Show.S02', 'Show.S01E00', 'Show - OVA - 01', 'Show.2023.S01E02', 'Show.S01.E02', 'Show S01 E02'].map((t) => pen(t)),
  pen('Show.S01E02', 'Show/Specials/Show.S01E02.mkv'), pen('Show 103', 'Show/Season 00/Show 103.mkv'),
  ...['Show/Specials/ep.mkv', 'Show.OVA.1080p', 'Show.12.5.1080p', 'Show.S01E00', 'Show 1x00', 'Show.S01E01', 'Season 00/x.mkv', 'Show.SP01'].map(special),
  msbt('Show.S01.The.Making.Of.mkv', [{ title: 'Making' }, { title: 'The Making Of' }]), msbt('Show.Pilot.mkv', [{ title: 'ab' }, { title: null }, {}]), msbt('x.mkv', []),
];

// ---- apply*
const TOKENS = ['{Movie Title}', '{Original Title}', '{Release Year}', '{Quality Full}', '{Quality Title}', '{Release Group}', '{TMDB Id}', '{MediaInfo AudioCodec}', '{MediaInfo VideoCodec}',
  '{Series Title}', '{season:00}', '{episode:00}', '{Episode Title}', '{Air Date}', '{season}', '{movie title}', '{Foo}', '{', '}', '{}', '{Quality Full', 'Quality Full}'];
const LIT = ['', ' ', '  ', ' - ', '(', ')', '[', ']', '()', '( )', '[ ]', '(  )', 'undefined', 'Undefined', 'undefinedx', ':', '"', '/', '\\', '|', '?', '*', '<', '>', '\u0001', '\u001f', '\t', ' ', '﻿', 'é', '日本', '.', '..', 'x', 'Show'];
const mkFormat = (): string => {
  if (chance(0.03)) return '';
  return Array.from({ length: ri(rng, 1, 8) }, () => (chance(0.55) ? pick(rng, TOKENS) : pick(rng, LIT))).join(chance(0.5) ? ' ' : '');
};
const TXT = ['', 'Nova Skyline', 'Nova: Skyline', 'Nova / Skyline', 'Title.', 'undefined', '{Release Year}', '{Quality Full} x', 'Tab\tHere', 'Ctrl\u0007Char', '  spaced  ', 'Çafé 日本', '..', '.', 'A  B', '( )', '[x] (y)', 'Éclair', 'null'];
const NUM = [undefined, null, 0, 1, 7, 12, 99, 100, 2023, -1];
const txt = (): unknown => (chance(0.1) ? undefined : chance(0.05) ? null : pick(rng, TXT));
const obj = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const applyGen: unknown[] = [];
for (let i = 0; applyGen.length < 900; i++) {
  const f = maybeDiverge(rng, mkFormat(), 0.1);
  const t = txt();
  switch (i % 5) {
    case 0: applyGen.push(fmt('applyMovieFormat', f, obj({ title: t ?? '', originalTitle: chance(0.5) ? txt() : undefined, year: pick(rng, NUM), quality: pick(rng, ['', '1080p', 'WEBDL-1080p', undefined as unknown as string]), releaseGroup: chance(0.5) ? txt() : undefined, tmdbId: pick(rng, NUM) }))); break;
    case 1: applyGen.push(fmt('applySeriesFormat', f, obj({ seriesTitle: t ?? '', season: pick(rng, [0, 1, 9, 10, 100, -1]), episode: pick(rng, [0, 1, 9, 10, 100, -3]), episodeTitle: chance(0.6) ? txt() : undefined, quality: pick(rng, ['', '720p']), releaseGroup: chance(0.5) ? txt() : undefined, airDate: chance(0.5) ? pick(rng, [null, '2020-01-02', '']) : undefined }))); break;
    case 2: applyGen.push(fmt('applyMovieFolderFormat', f, obj({ title: t ?? '', originalTitle: chance(0.5) ? txt() : undefined, year: pick(rng, NUM), tmdbId: pick(rng, NUM) }))); break;
    case 3: applyGen.push(fmt('applySeriesFolderFormat', f, obj({ seriesTitle: t ?? '', originalTitle: chance(0.5) ? txt() : undefined, year: pick(rng, NUM), tmdbId: pick(rng, NUM) }))); break;
    default: applyGen.push(fmt('applySeasonFolderFormat', chance(0.5) ? pick(rng, ['Season {season:00}', 'S{season}', '{season}{season:00}', '', 'Saison {season:00} {Foo}']) : f, { season: pick(rng, [0, 1, 9, 10, 100, -1]) }));
  }
}

// ---- getFormats
const KEYS = ['naming_movie_format', 'naming_movie_folder_format', 'naming_series_format', 'naming_series_folder_format', 'naming_season_folder_format'];
const gfGen: unknown[] = [];
for (let mask = 0; mask < 32; mask++) gfGen.push(gf(KEYS.filter((_, k) => mask & (1 << k)).map((key) => ({ key, value: pick(rng, ['', null, 'custom {Movie Title}', ' ']) }))));
while (gfGen.length < 60) gfGen.push(gf([...KEYS.filter(() => chance(0.5)).map((key) => ({ key, value: pick(rng, ['', null, 'v1']) })), { key: 'other', value: 'z' }, ...(chance(0.3) ? [{ key: KEYS[0], value: 'dup' }] : [])]));

// ---- parsing
const NAMES = ['Show', 'Show.Name', 'Nova Skyline', 'Show_Name', 'Éclair', 'Spy-Fi'];
const SEP = ['.', '_', ' ', '-'];
const YEARS = ['', '.2023', '.2023.', ' 2023 ', '_2023_'];
const MARKERS = ['', ' OVA 02', '.SP01', ' Special 3', ' NCED 1', ' OVA 00', ' OAV.1', '.Specials', '.12.5', '.S01E00', ' 1x00', ' ncop2'];
const PAT: Array<(s: string) => string> = [
  (s) => `S${ri(rng, 0, 99)}E${ri(rng, 0, 120)}`, (s) => `S0${ri(rng, 1, 9)}E0${ri(rng, 1, 9)}${s}E0${ri(rng, 1, 9)}`, (s) => `s0${ri(rng, 1, 9)}e0${ri(rng, 1, 5)}-E0${ri(rng, 1, 9)}`,
  () => `S01E01E02E04`, (s) => `S01E05${s}06`, (s) => `S0${ri(rng, 1, 9)}${s}E0${ri(rng, 1, 9)}`, (s) => `S0${ri(rng, 1, 9)} E0${ri(rng, 1, 9)}`, () => `${ri(rng, 1, 20)}x${ri(rng, 0, 120)}`,
  () => `${ri(rng, 1, 9)}${String(ri(rng, 0, 99)).padStart(2, '0')}`, (s) => `Part${s}${ri(rng, 1, 9)}`, (s) => `Pt.${ri(rng, 1, 9)}`, (s) => `Episode${s}${ri(rng, 1, 99)}`, (s) => `Ep ${ri(rng, 0, 9)}`,
  (s) => `-${s}${String(ri(rng, 0, 120)).padStart(2, '0')}`, () => `E${String(ri(rng, 0, 120)).padStart(2, '0')}`, () => `S0${ri(rng, 1, 9)}`, () => `S0${ri(rng, 1, 9)}E1000`, () => `S100E01`,
];
const penGen: unknown[] = [];
for (let i = 0; penGen.length < 700; i++) {
  const s = pick(rng, SEP);
  const t = maybeDiverge(rng, [pick(rng, NAMES), chance(0.5) ? pick(rng, YEARS).replace(/^[. _]/, '') : '', PAT[i % PAT.length](s), pick(rng, ['', '1080p', 'x265', '720p.WEB-DL'])].filter(Boolean).join(s) + pick(rng, MARKERS) + pick(rng, ['', '.mkv', '-GRP']), 0.15);
  const path = chance(0.3) ? pick(rng, ['Show/Specials/', 'Show/Season 00/', 'Show/Season 01/', 'Show\\Specials\\', 'Show/Saison.0/', '']) + t : undefined;
  penGen.push(pen(t, path));
}

// ---- release group / special / match
const grpGen: unknown[] = [];
const GTAIL = ['', '-GRP', '-grp', '-GRP.mkv', '-GRP.MKV', '.mkv', '-1080p', '-DL', '_X-GRP', '-GRP.a', '-GRP.abcde', '-É', '-GRP-', '-', '-GR_P', '-GRP.torrent'];
while (grpGen.length < 120) grpGen.push(group(maybeDiverge(rng, pick(rng, ['Show.S01E02.1080p.WEB-DL', 'Movie.2019', 'a', '', 'x-y']) + pick(rng, GTAIL), 0.2)));
const spGen: unknown[] = [];
const SPW = ['Specials', 'special', 'Season 00', 'saison.0', 'Season 0', 'OVA', 'oav', 'ovd', 'ncop', 'nced', 'SP', 'Special 3', 'OVA 02', 'sp01', 'S01E00', '1x00', '12.5', '1.5', '123.5', '1234.5', 'Show', 'Showspecial', 'xova', 'S00E01', 'Season 10'];
while (spGen.length < 200) {
  const w = pick(rng, SPW);
  const pre = pick(rng, ['', 'Show/', 'Show\\', 'Show ', 'Show.', 'Show-']);
  const post = pick(rng, ['', '/ep.mkv', '\\ep.mkv', ' x', '.mkv', '1', '.5']);
  spGen.push(special(maybeDiverge(rng, pre + w + post, 0.2)));
}
const TT = ['The Making Of', 'Making', 'Pilot Run', 'Behind the Scenes', 'ab', 'Café', 'Cafe Society', 'Éclair', '', 'Nova Skyline', 'Skyline', 'The', 'Making Of Nova', 'OVA', 'Special Ép'];
const mGen: unknown[] = [];
while (mGen.length < 150) {
  const specials = Array.from({ length: ri(rng, 0, 5) }, () => (chance(0.1) ? (chance(0.5) ? {} : { title: null }) : { title: pick(rng, TT) }));
  const name = pick(rng, ['Show.S01.The.Making.Of.mkv', 'Cafe.Society.mkv', 'Pilot-Run.avi', 'Nova Skyline Making Of.mkv', 'dir/Behind_the_scenes.mkv', 'The.Making.Of.Nova.mkv', 'Éclair.mkv', 'Special.Ep.mkv', 'x.mkv', '.mkv', 'a.b.c.mkv', 'Pilot Run Pilot Run.mkv', 'dir.d/Skyline']);
  mGen.push(msbt(maybeDiverge(rng, name, 0.2), specials));
}

const svc = (rows: object[] = []) => new NamingService({ query: async () => rows } as never);
const run = (i: any): unknown => {
  const s = svc(i.rows);
  switch (i.fn) {
    case 'getFormats': return svc(i.rows).getFormats();
    case 'applyMovieFormat': return s.applyMovieFormat(i.format, i.data);
    case 'applySeriesFormat': return s.applySeriesFormat(i.format, i.data);
    case 'applyMovieFolderFormat': return s.applyMovieFolderFormat(i.format, i.data);
    case 'applySeriesFolderFormat': return s.applySeriesFolderFormat(i.format, i.data);
    case 'applySeasonFolderFormat': return s.applySeasonFolderFormat(i.format, i.data);
    case 'extractReleaseGroup': return s.extractReleaseGroup(i.title);
    case 'parseEpisodeNumbers': return s.parseEpisodeNumbers(i.title, i.filePath);
    case 'isSpecialFile': return s.isSpecialFile(i.path);
    default: { const r = s.matchSpecialByTitle(i.filename, i.specials); return r ? i.specials.indexOf(r) : null; }
  }
};

(async () => {
  const all = [...spec, ...applyGen, ...gfGen, ...grpGen, ...penGen, ...spGen, ...mGen];
  await emit('naming', all, run);
  console.log(`naming total=${all.length} spec=${spec.length} apply=${applyGen.length} getFormats=${gfGen.length} group=${grpGen.length} parse=${penGen.length} special=${spGen.length} match=${mGen.length}`);
})();
