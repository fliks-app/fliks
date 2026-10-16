import { APP_QUALITIES, getAppQualityById } from '../../src/common/constants/app-qualities';
import { parseReleaseQuality } from '../../src/common/release-parsing/quality.parser';
import { rankFromQualityString } from '../../src/common/release-scoring/release-rejection.helper';
import { emit, mulberry32, pick, ri } from './_util';

const parse = (title: string) => ({ fn: 'parseReleaseQuality', title });
const rank = (quality: string | null) => ({ fn: 'rankFromQualityString', quality });

// quality.parser.spec.ts
const specInputs: unknown[] = [
  parse('Show.S01E01.4320p.WEB-DL.x265'),
  parse('Show.S01E01.8K.WEB-DL.x265'),
  parse('Show.S01E01.1080p.WEB-DL.x264'),
];

// stored media_files.quality strings: the table names, their lower/upper cases, and what the importers write
const stored = [
  ...APP_QUALITIES.map((q) => q.name),
  ...APP_QUALITIES.map((q) => q.name.toLowerCase()),
  'Unknown', '', ' ', '8K', '4320p', '576p', '360p', '1080p', '2160p', '720p', '480p', 'SD', 'HD', 'Bluray', 'WEBDL', 'WEB-DL 1080p',
  'HDTV-576p', 'Remux-4320p', 'Remux', 'DVD-R', 'DVDRip', 'Bluray-1080p\n',
];
const releases = [
  'The.Movie.2020.1080p.BluRay.x264-GRP', 'The.Movie.2020.2160p.UHD.BluRay.REMUX.HDR.HEVC-GRP', 'Show.S02E03.720p.HDTV.x264-GRP',
  'Show.S02E03.WEBRip.x264-GRP', 'Show.S02E03.WEB.DL.1080p.AAC', 'Show.S02E03.2160p.HDR.HEVC-GRP', 'Movie.2019.CAM.XviD', 'Movie.2019.HDCAM.XviD',
  'Movie.2019.TS.x264', 'Movie.2019.TELESYNC.x264', 'Movie.2019.TC.x264', 'Movie.2019.TELECINE.x264', 'Movie.2019.DVDRip.XviD', 'Movie.2019.DVD-R.PAL',
  'Movie.2019.SDTV.XviD', 'Movie.2019.BDRip.x264', 'Movie.2019.BRRip.480p', 'Movie.2019.BDR.576p', 'Movie.2019.4K.WEBRip', 'Movie.2019.UHD', 'Movie.2019.1080i.HDTV',
  'Movie.2019.360p.WEB-DL', 'Movie.2019.WEBDL-480p', 'Movie.2019.web-rip.720p', 'L\'Impossible.2012.FRENCH.1080p.BluRay', 'Éclair.2010.MULTI.720P.WEB-DL',
  'İstanbul.2010.1080p', 'Movie 2019 1080p Remux', 'Movie_2019_1080p_BluRay', 'Movie-2019-2160p-WEBRip', 'ΣΑΣ.2010.1080p.WEB-DL', 'movie.cam.2160p', 'Movie.TS.Edition.1080p.BluRay',
  'no quality here', 'x264 only', '4320p', '8k', '4k', '2160', '1080', '720', 'abc720pdef', 'camera.1080p', 'tsunami.720p', 'tcl.1080p.BluRay', 'Movie.remux', 'Movie.web-dl',
];
for (const s of stored) specInputs.push(parse(s), rank(s));
for (const s of releases) specInputs.push(parse(s), rank(s));
specInputs.push(rank(null));
for (const id of [0, 1, 18, 24, 25, -1, 99, 1e9]) specInputs.push({ fn: 'getAppQualityById', id });
const specCount = specInputs.length;

// seeded combinations of release tokens
const rng = mulberry32(0x9a11);
const SRC = ['', 'BluRay', 'Blu-ray', 'BDRip', 'BRRip', 'BDR', 'WEB-DL', 'WEBDL', 'WEB.DL', 'WEBRip', 'WEB-Rip', 'WEB', 'HDTV', 'DVDRip', 'DVD', 'DVDR', 'DVD-R', 'SDTV', 'REMUX', 'CAM', 'TS', 'TELESYNC', 'TC', 'TELECINE'];
const RES = ['', '480p', '576p', '360p', '480', '720p', '720', '720i', '1080p', '1080i', '1080', '2160p', '2160', '4K', 'UHD', '4320p', '8K'];
const MISC = ['x264', 'x265', 'HEVC', 'HDR', 'AAC', 'DTS', 'FRENCH', 'MULTI', '2020', 'GRP', 'PROPER', 'Éclair', 'İ', 'camera', 'tsar'];
const SEP = ['.', ' ', '-', '_', '.'];
const gen: unknown[] = [];
for (let i = 0; i < 400; i++) {
  const parts = [pick(rng, ['Movie', 'Show.S01E01', 'The.Title', 'Film']), pick(rng, RES), pick(rng, SRC), ...Array.from({ length: ri(rng, 0, 3) }, () => pick(rng, MISC))].filter(Boolean);
  if (rng() < 0.5) parts.sort(() => rng() - 0.5);
  let s = parts.join(pick(rng, SEP));
  if (rng() < 0.2) s = s.toUpperCase();
  gen.push(parse(s));
  if (i % 4 === 0) gen.push(rank(s));
}

function run(i: any): unknown {
  switch (i.fn) {
    case 'parseReleaseQuality': return parseReleaseQuality(i.title);
    case 'rankFromQualityString': return rankFromQualityString(i.quality);
    default: return getAppQualityById(i.id) ?? null;
  }
}

(async () => {
  await emit('release-quality', [...specInputs, ...gen], run);
  await emit('app-qualities', [{ fn: 'APP_QUALITIES' }], () => APP_QUALITIES);
  console.log(`release-quality spec=${specCount} generated=${gen.length}`);
})();
