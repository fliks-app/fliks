import { Logger } from '@nestjs/common';
import { atCueTime, SubtitleBurnInService } from '../../src/modules/streaming/subtitle-burn-in.service';
import { SubtitleStreamService } from '../../src/modules/streaming/subtitle-stream.service';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

const cue = (filter: string, offset?: number) => ({ fn: 'atCueTime', filter, offset });
const bf = (info: object) => ({ fn: 'buildFilter', info });
const rend = (embedded: object[], external: object[], externalFails = false) => ({ fn: 'listTextSubtitleRenditions', embedded, external, externalFails });

// subtitle-burn-in-timing.spec.ts, subtitle-renditions.spec.ts
const specInputs: unknown[] = [
  cue("subtitles='/s.srt'", 2.778667),
  cue("ass='/s.ass'", -1.022),
  cue("subtitles='/s.srt'", 0),
  bf({ type: 'text', videoPath: '/m/v.ts', subtitlePath: '/m/v.srt', codec: 'subrip', cueOffsetSeconds: 95000 }),
  bf({ type: 'text', videoPath: '/m/v.mkv', streamIndex: 5, subtitleOrdinal: 1, codec: 'subrip' }),
  rend([], [
    { id: 1, relativePath: 'm.en.sup', codec: 'hdmv_pgs_subtitle', language: 'en' },
    { id: 2, relativePath: 'm.en.sub', codec: null, language: 'en' },
    { id: 3, relativePath: 'm.en.SRT', codec: null, language: 'en' },
    { id: 4, relativePath: 'm.fr.vtt', codec: null, language: 'fr' },
    { id: 5, relativePath: null, codec: 'subrip', language: 'de' },
  ]),
  rend([
    { streamIndex: 3, language: 'chi', languageTag: 'zh-Hant', codec: 'subrip' },
    { streamIndex: 4, language: 'eng', codec: 'subrip' },
  ], []),
  rend([{ streamIndex: 3, language: 'chi', languageTag: null, codec: 'subrip' }], []),
  rend([{ streamIndex: 3, language: 'eng', codec: 'subrip' }], [{ id: 1, relativePath: 'm.en.srt', codec: null, language: 'en' }], true),
];
const specCount = specInputs.length;

// seeded generated input
const rng = mulberry32(0xb0bb);
const R = (lo: number, hi: number) => ri(rng, lo, hi);
const gen: unknown[] = [];
const OFFSETS = [0, 1.5, -1.022, 95000, 2.778667, 0.0000004, -0.5, 1e-7, 12345.6789012];
const PATHS = ['/m/v.srt', '/m/v.ass', '/m/V.SSA', '/m/a:b.srt', "/m/it's.srt", '/m/back\\slash.srt', "/m/a:b'c\\d.ass", '/m/no-ext', '/m/v.vtt', '/m/C:\\x\\y.SRT', '/m/sp ace.srt', '/m/q\'\'.ssa'];
for (const p of PATHS) {
  gen.push(bf({ type: 'text', videoPath: '/m/v.mkv', subtitlePath: p, codec: 'subrip', cueOffsetSeconds: pick(rng, OFFSETS) }));
  gen.push(bf({ type: 'text', videoPath: p, streamIndex: R(0, 9), subtitleOrdinal: R(0, 4), codec: 'ass' }));
}
for (let i = 0; i < 40; i++) {
  const type = pick(rng, ['text', 'text', 'image']);
  gen.push(bf({
    type, videoPath: pick(rng, PATHS), subtitlePath: pick(rng, [undefined, ...PATHS]), streamIndex: pick(rng, [undefined, R(0, 9)]),
    subtitleOrdinal: pick(rng, [undefined, 0, R(1, 6)]), codec: pick(rng, ['subrip', 'ass', 'hdmv_pgs_subtitle', 'dvd_subtitle']),
    cueOffsetSeconds: pick(rng, [undefined, ...OFFSETS]),
  }));
}
for (let i = 0; i < 25; i++) {
  gen.push(cue(pick(rng, ["subtitles='/s.srt'", "ass='/a b.ass'", 'f']), pick(rng, [undefined, ...OFFSETS])));
}
const LANGS = ['eng', 'fre', 'chi', 'spa', 'und', 'xx', '', null, 'en', 'pt-BR'];
const CODECS = [null, 'subrip', 'ass', 'hdmv_pgs_subtitle', 'dvd_subtitle', 'webvtt', 'mov_text'];
const EXT = ['srt', 'SRT', 'vtt', 'ass', 'ssa', 'sub', 'sup', 'idx', 'txt'];
for (let i = 0; i < 35; i++) {
  const embedded = Array.from({ length: R(0, 4) }, (_, k) => ({
    streamIndex: R(2, 20) + k, language: pick(rng, LANGS), languageTag: pick(rng, [undefined, null, 'zh-Hant', 'es-419']),
    title: pick(rng, [undefined, '', 'Commentary', 'SDH']), forced: pick(rng, [undefined, true, false]),
    isImageBased: pick(rng, [undefined, false, true]), codec: pick(rng, CODECS),
  }));
  const external = Array.from({ length: R(0, 5) }, (_, k) => ({
    id: k + 1, relativePath: pick(rng, [null, `m.${pick(rng, EXT)}`, `d/m.en.${pick(rng, EXT)}`, 'noext']),
    codec: pick(rng, CODECS), language: pick(rng, LANGS), forced: pick(rng, [undefined, true, false]),
  }));
  gen.push(rend(embedded, external));
}

async function run(i: any): Promise<unknown> {
  switch (i.fn) {
    case 'atCueTime': return atCueTime(i.filter, i.offset);
    case 'buildFilter': return SubtitleBurnInService.prototype.buildFilter.call({}, i.info);
    default: {
      const svc = new SubtitleStreamService(
        { find: async () => { if (i.externalFails) throw new Error('db down'); return i.external; } } as never,
        { resolveFile: async () => ({ mediaFile: { streamInfo: i.embedded.length ? { subtitles: i.embedded } : null } }) } as never,
      );
      return svc.listTextSubtitleRenditions(1);
    }
  }
}

emit('burn-in', [...specInputs, ...gen], run).then(() => console.log(`burn-in spec=${specCount} generated=${gen.length}`));
