// Needs the pre-S5 Nest sources: the scorer there still parses release names (S5 removed them).
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { RELEASES } from './_corpus';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);
const root = process.env.PRE_S5_SRC;
if (!root) throw new Error('PRE_S5_SRC=<pre-S5 backend>/src is required');
const { scoreSubtitle } = require(join(root, 'modules/subtitles/subtitle-scorer'));
const { SubtitlesService } = require(join(root, 'modules/subtitles/subtitles.service'));

const rng = mulberry32(0x5ea4c4);
const TITLES = ['Sample Show', 'The Movie', 'Nova Skyline', "L'Impossible", 'Éclair', 'Mr. Robot'];
const REL = [...RELEASES, 'Mr.Robot.S01E03.1080p.WEB-DL.DD5.1.H.264-GRP', 'Sample.Show.S01E01.1080p.BluRay.x265.DTS-CtrlHD',
  'Sample.Movie.2021.2160p.UHD.BluRay.x265.DV.HDR.DTS-HD.MA.7.1-CtrlHD', 'The.Movie.2020.1080p.BluRay.x264-GRP', 'the movie 2020 720p'];
const MODES = [undefined, 'prefer', 'avoid', 'require', 'forbid'];

const scoreCases: unknown[] = [];
const IMDB = [undefined, null, '', 'tt0000001', '0000001', 'tt0000002', '1'];
for (let i = 0; i < 400; i++) {
  const episode = rng() < 0.5;
  scoreCases.push({
    fn: 'scoreSubtitle',
    candidate: {
      ...(rng() < 0.8 ? { releaseName: rng() < 0.1 ? '' : pick(rng, REL) } : {}),
      ...(rng() < 0.15 ? { hashMatched: true } : {}),
      ...(rng() < 0.5 ? { imdbId: pick(rng, IMDB) } : {}),
      ...(rng() < 0.7 ? { hearingImpaired: pick(rng, [true, false]) } : {}),
    },
    context: {
      kind: episode ? 'episode' : 'movie',
      videoReleaseName: rng() < 0.85 ? pick(rng, REL) : null,
      title: pick(rng, TITLES),
      year: pick(rng, [null, undefined, 0, 2015, 2020, 2021, 2019]),
      ...(episode ? { season: pick(rng, [null, 1, 2]), episode: pick(rng, [null, 1, 3]) } : {}),
      imdbId: pick(rng, IMDB),
      hearingImpairedMode: pick(rng, MODES),
    },
  });
}

const PROVIDERS = [{ id: 1, name: 'OpenSubtitles', type: 'opensubtitles', settings: {} }, { id: 2, name: 'Subdl', type: 'subdl', settings: {} }, { id: 3, name: 'YIFY', type: 'yify', settings: {} }];
const LANGS = ['en', 'eng', 'fr', 'fre', 'fr-CA', 'en_US', 'de'];
function cand(type: string, n: number) {
  const rel = rng() < 0.75 ? pick(rng, REL) : undefined;
  return {
    providerFileId: `f${ri(rng, 1, 6)}-${n % 3}`,
    title: rel ?? 'x',
    ...(rel ? { releaseName: rng() < 0.5 ? rel : rel.toUpperCase() } : {}),
    ...(rng() < 0.4 ? { imdbId: pick(rng, ['0000001', '0000002', 'tt0000001']) } : {}),
    ...(rng() < 0.15 ? { hashMatched: true } : {}),
    language: pick(rng, LANGS),
    forced: rng() < 0.2,
    hearingImpaired: rng() < 0.3,
    score: ri(rng, 0, 100),
    ...(rng() < 0.6 ? { downloadCount: ri(rng, 0, 5) * 100 } : {}),
    providerName: type,
    providerType: type,
  };
}
const searchCases: unknown[] = [];
for (let i = 0; i < 160; i++) {
  const episode = rng() < 0.5;
  const byType: Record<string, any[]> = {};
  for (const p of PROVIDERS) byType[p.type] = Array.from({ length: ri(rng, 0, 5) }, (_, n) => cand(p.type, n));
  searchCases.push({
    fn: 'searchSubtitles',
    results: byType,
    blacklist: rng() < 0.4 ? [{ providerType: 'subdl', providerFileId: `f${ri(rng, 1, 6)}-${ri(rng, 0, 2)}` }] : [],
    params: {
      ...(rng() < 0.7 ? { imdbId: pick(rng, ['tt0000001', 'tt0000002']) } : {}),
      title: pick(rng, TITLES),
      ...(rng() < 0.8 ? { year: pick(rng, [2015, 2020, 2021]) } : {}),
      ...(episode ? { season: pick(rng, [1, 2]), episode: pick(rng, [1, 3]) } : {}),
      language: pick(rng, ['en', 'fr', 'eng', 'fre']),
      ...(rng() < 0.8 ? { videoReleaseName: pick(rng, REL) } : {}),
      ...(rng() < 0.5 ? { forced: pick(rng, [true, false]) } : {}),
      ...(rng() < 0.6 ? { hearingImpairedMode: pick(rng, MODES.slice(1)) } : {}),
    },
  });
}

async function run(i: any): Promise<unknown> {
  if (i.fn === 'scoreSubtitle') return scoreSubtitle(i.candidate, i.context);
  const svc = Object.create(SubtitlesService.prototype) as any;
  svc.logger = new Logger('x');
  svc.providerService = { findEnabled: async () => PROVIDERS };
  svc.factory = { create: (type: string) => ({ search: async () => i.results[type].map((r: any) => ({ ...r })) }) };
  svc.statRepo = { save: async () => undefined, create: (x: any) => x };
  svc.blacklistRepo = { find: async () => i.blacklist };
  return svc.searchSubtitles({ ...i.params });
}

emit('subtitle-search', [...scoreCases, ...searchCases], run).then(() =>
  console.log(`subtitle-search score=${scoreCases.length} search=${searchCases.length}`),
);
