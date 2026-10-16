import { Logger } from '@nestjs/common';
import { matchSubtitleVideo } from '../../src/modules/subtitles/subtitle-matching';
import { SubtitlesService } from '../../src/modules/subtitles/subtitles.service';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

const rng = mulberry32(0x5b71);
const svc = Object.create(SubtitlesService.prototype) as SubtitlesService;

const parse = (name: string) => ({ fn: 'parseSubtitleFilename', name });
const match = (entry: string, files: string[], dir = '/m', own = true) => ({
  fn: 'matchSubtitleVideo',
  entry,
  dir,
  mediaPath: '/m',
  files,
  hasOwnFolder: own,
});

// subtitle-filename.spec.ts plus the language/flag cases the companion listing and discovery rely on
const specInputs: unknown[] = [
  ...['Movie.en.hi.srt', 'Movie.hi.srt', 'Movie.fr.hi.forced.srt', 'Movie.fr.ocr.srt', 'Movie.fr.mkv',
    'Movie.fre.srt', 'Movie.fra.srt', 'Movie.en-US.srt', 'Movie.pt-BR.srt', 'Movie.French.srt', 'Movie.french.srt',
    'Movie.srt', 'Movie.SRT', 'Movie.EN.srt', 'Movie.nfo', 'Movie', '.srt', 'a.srt', '.en.srt', 'Movie.xx.srt',
    'Movie.und.srt', 'Movie.zzz.srt', 'Movie.forced.srt', 'Movie.foreign.en.srt', 'Movie.en.sdh.srt',
    'Movie.en.cc.srt', 'Movie.hi.en.srt', 'Movie.en.hi.hi.srt', 'Movie.default.en.srt', 'Movie.en.default.srt',
    'Movie.x.en.srt', 'Movie.en.x.srt', 'Movie.en-.srt', 'Movie.e-us.srt', 'Movie.en-u.srt', 'Movie.EN-US.srt',
    'Movie.a.b.c.en.forced.hi.srt', 'M.ass', 'M.en.ssa', 'M.en.vtt', 'M.en.sub', 'M.en.sup', 'M.en.idx',
    'M.en.SUP', 'M.Éclair.en.srt', 'Show.S01E01.1080p.WEB-DL.fr.srt'].map(parse),
  match('A (2020).cut.en.srt', ['A (2020).mkv', 'A (2020).cut.mkv']),
  match('A (2020).en.srt', ['A (2020).mkv', 'A (2020).cut.mkv']),
  match('other.srt', ['A (2020).mkv', 'A (2020).cut.mkv']),
  match('A (2020).SRT', ['A (2020).mkv', 'A (2020).cut.mkv']),
  match('other.srt', ['A (2020).mkv']),
  match('other.srt', ['A (2020).mkv'], '/m', false),
  match('other.srt', ['Season 1/A.mkv'], '/m'),
  match('other.srt', ['Season 1/A.mkv'], '/m/Season 1'),
  match('other.srt', ['Season 1/A.mkv', 'Season 1/B.mkv'], '/m/Season 1'),
  match('other.srt', ['A.mkv', 'Season 1/B.mkv'], '/m'),
  match('S01E01.en.srt', ['Season 1/S01E01.mkv', 'Season 1/S01E02.mkv'], '/m/Season 1'),
  match('Movie.srt', []),
];

const BASES = ['Movie', 'Show.S01E01', 'A (2020)', 'Éclair', 'a.b.c', 'x', 'Movie.2019.1080p'];
const TOKENS = ['en', 'fr', 'hi', 'eng', 'fre', 'fra', 'spa', 'French', 'english', 'EN', 'en-US', 'pt-BR', 'zh-Hans', 'forced',
  'foreign', 'sdh', 'cc', 'HI', 'default', 'ocr', 'xx', 'und', 'zzz', 'junk', '1080p', 'Forced', 'SDH', 'de', 'ja', 'kor'];
const EXTS = ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.sup', '.SRT', '.Srt', '.nfo', '.mkv', ''];
const gen: unknown[] = [];
for (let i = 0; i < 160; i++) {
  const toks = Array.from({ length: ri(rng, 0, 4) }, () => pick(rng, TOKENS));
  gen.push(parse([pick(rng, BASES), ...toks].join('.') + pick(rng, EXTS)));
}
const VIDEOS = ['A.mkv', 'A.cut.mkv', 'A.2019.mp4', 'Season 1/A.mkv', 'Season 1/B.mkv', 'B.mkv', 'a.MKV', 'x/Movie.mkv', 'Movie.mkv'];
const ENTRIES = ['A.en.srt', 'A.cut.en.srt', 'a.en.srt', 'A.2019.fr.srt', 'B.srt', 'B.fr.forced.srt', 'C.srt', 'A.SRT', 'A.cut.SRT',
  'A.cut.srt', 'Movie.en.srt', 'A.en.cut.srt', 'a.b.c.srt', 'x.srt'];
for (let i = 0; i < 120; i++) {
  const files = Array.from(new Set(Array.from({ length: ri(rng, 0, 4) }, () => pick(rng, VIDEOS))));
  gen.push(match(pick(rng, ENTRIES), files, pick(rng, ['/m', '/m', '/m/Season 1', '/m/x']), rng() < 0.7));
}

function run(i: any): unknown {
  if (i.fn === 'parseSubtitleFilename') return svc.parseSubtitleFilename(i.name);
  const files = i.files.map((relativePath: string) => ({ relativePath }));
  const hit = matchSubtitleVideo(i.entry, i.dir, files, i.mediaPath, i.hasOwnFolder);
  return hit ? files.indexOf(hit) : null;
}

emit('subtitles', [...specInputs, ...gen], run).then(() =>
  console.log(`subtitles spec=${specInputs.length} generated=${gen.length}`),
);
