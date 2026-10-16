import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseEdl } from '../../src/modules/media/edl/edl-parser';
import { edlPathFor, readEdlSidecar, resetEdlSidecarState, shiftRanges } from '../../src/modules/media/edl/edl-sidecar';
import { emit, mulberry32, pick, ri } from './_util';

Logger.overrideLogger(false);

const parse = (text: string, fps?: number) => ({ fn: 'parseEdl', text, fps });
const shift = (ranges: object[], by: number) => ({ fn: 'shiftRanges', ranges, shift: by });
const sidecar = (files: Record<string, unknown>, fps?: number) => ({ fn: 'readEdlSidecar', files, fps });
const steps = (...s: object[]) => ({ fn: 'readEdlSidecarSteps', steps: s });
const r = (start: number, end: number, action: string) => ({ start, end, action });

const many = (n: number) => Array.from({ length: n }, (_, i) => `${i * 2} ${i * 2 + 1} 0`).join('\n');
const FRAMES = '#127   #170    0\n#360   #400    1\n#10080 #19728  3\n#1     #6127   2\n#17282         2\n';

// edl-parser.spec.ts, edl-sidecar.spec.ts
const specInputs: unknown[] = [
  parse(['5.3   7.1    0', '15    16.7   1', '## This is a comment kodi should happily ignore when parsing', '420   822    3', '1     255.3  2', '720.1        2'].join('\n')),
  parse('5.3   7.1    0\n15    16.7   1\n## comment\n420   822    3\n1     255.3  2\n720.1        2\n'),
  parse('5.3     7.1     0\n15      16.7    1\n7:00    13:42   3\n1       4:15.3  2\n12:00.1         2\n'),
  parse('5.3   7.1    0\n15    16.7   3\n18    19     0\n25    36.7   3\n'),
  parse(FRAMES, 25),
  parse(FRAMES),
  parse(['## first commbreak should be automatically removed', '0    1     3', '10   22    3', '30   32    3', '37   50    3', '52   60    3', '62   65.1  3'].join('\n')),
  parse('FILE PROCESSING COMPLETE\r\n------------------------\r\n12693\t17792\r\n'),
  parse('﻿1\t2\t0\r3 4 1 extra\r5 6 3'),
  parse('1:02.5 1:03.123456 0\n1:00:00 1:00:01 0'),
  parse(['-1 5 0', '1,5 3 0', '5 5 0', '9 4 0', '1 2 7', '1 2 x', '10 20 0', '15 25 1', '20 30 1', '1', '4 5'].join('\n')),
  parse('30 40 0\n10 20 0'),
  parse(many(10001)),
  parse('.5 5. 0\n+1 2 0\n6 7,5 0'),
  parse('1 2 03\n3 4 1abc\n5 6 0.0\n7 8 x1\n9 10 4'),
  parse('10 20 0\n30 40 0\n15 16 0\n25 35 0\n20 30 1\n5 10 1'),
  parse(''),
  parse('\n\n   \n## only comments\n'),
  parse('#5 2\n#5 #9 0', 24),
  parse('1 2 0', 0),
  { fn: 'edlPathFor', video: '/m/Show.S01E01.1080p.mkv' },
  { fn: 'edlPathFor', video: '/m/noext' },
  shift([r(0, 5, 'cut'), r(10, 20, 'mute')], -0.1),
  shift([r(1, 2, 'cut'), r(0.0004, 0.0006, 'mute')], 0.1234567),
  shift([r(0, 1, 'cut')], -2),
  sidecar({}),
  sidecar({ 'a.edl': { dir: true } }),
  sidecar({ 'a.edl': '1 2 0\n' }),
  sidecar({ 'a.edl': '1 2 0\n5 6 1\n' }),
  sidecar({ 'a.edl': '#50 #100 0\n' }, 25),
  sidecar({ 'a.edl': '#50 #100 0\n' }),
  sidecar({ 'A.EDL': '1 2 0\n' }),
  sidecar({ 'a.edl': { fill: '#', size: 1024 * 1024 + 1 } }),
  sidecar({ 'a.edl': '#'.repeat(1024) }),
  steps({ files: { 'a.edl': '1 2 0\n' }, mtime: 1 }, { files: { 'a.edl': '1 2 0\n5 6 1\n' }, mtime: 2 }),
  steps({ files: { 'a.edl': '1 2 0\n' }, mtime: 1 }, { files: { 'a.edl': '3 4 0\n' }, mtime: 1 }),
  steps({ files: { 'a.edl': '#50 #100 0\n' }, mtime: 1, fps: 25 }, { files: {} }),
];
const specCount = specInputs.length;

// seeded generated input
const rng = mulberry32(0xed1);
const R = (lo: number, hi: number) => ri(rng, lo, hi);
const time = () => pick(rng, [
  () => String(R(0, 900)), () => `${R(0, 900)}.${R(0, 9999)}`, () => `.${R(1, 99)}`, () => `${R(0, 99)}.`,
  () => `${R(0, 59)}:${String(R(0, 59)).padStart(2, '0')}`, () => `${R(0, 3)}:${String(R(0, 59)).padStart(2, '0')}:${String(R(0, 59)).padStart(2, '0')}.${R(0, 99999)}`,
  () => `#${R(0, 20000)}`, () => pick(rng, ['-1', '+2', '1,5', 'abc', '1:2', '1:60:00', '#', '#x', '1e3', '0x10', '1:00:00:00']),
])();
const act = () => pick(rng, ['0', '1', '2', '3', '03', '1abc', '0.0', '4', '7', 'x', '', '9']);
const ws = () => pick(rng, [' ', '   ', '\t', ' \t ']);
function line(): string {
  const k = rng();
  if (k < 0.05) return '';
  if (k < 0.1) return '## c ' + R(0, 9);
  if (k < 0.15) return time();
  if (k < 0.2) return [time(), time(), act(), 'extra'].join(ws());
  if (k < 0.3) return [time(), act()].join(ws());
  return [time(), time(), act()].join(ws());
}
const gen: unknown[] = [];
for (let i = 0; i < 80; i++) {
  const lines = Array.from({ length: R(1, 12) }, line);
  const eol = pick(rng, ['\n', '\r\n', '\r']);
  gen.push(parse((rng() < 0.15 ? '﻿' : '') + lines.join(eol) + (rng() < 0.5 ? eol : ''), pick(rng, [undefined, 25, 23.976, 0])));
}
// sorted-and-disjoint insertion order stress
for (let i = 0; i < 20; i++) {
  const lines = Array.from({ length: R(5, 30) }, () => {
    const s = R(0, 60);
    return `${s} ${s + R(0, 8)} ${pick(rng, ['0', '1', '3', '2'])}`;
  });
  gen.push(parse(lines.join('\n')));
}
for (let i = 0; i < 15; i++) {
  const rs = Array.from({ length: R(0, 5) }, () => { const s = R(0, 100); return r(s, s + R(1, 30), pick(rng, ['cut', 'mute', 'commercial'])); });
  gen.push(shift(rs, pick(rng, [-50, -3.3, -0.0004, 0, 0.1234567, 12])));
}
for (let i = 0; i < 6; i++) {
  gen.push({ fn: 'edlPathFor', video: pick(rng, ['/a/b.c.mkv', '/x.mp4', 'rel/f.ts', '/m/a b/.hidden', '/m/dir.d/file', '/m/f.EDL']) });
}

async function run(i: any): Promise<unknown> {
  switch (i.fn) {
    case 'parseEdl': return parseEdl(i.text, i.fps);
    case 'edlPathFor': return edlPathFor(i.video);
    case 'shiftRanges': return shiftRanges(i.ranges, i.shift);
    case 'readEdlSidecarSteps': return readSteps(i.steps);
    default: return readSteps([{ files: i.files, fps: i.fps }]).then((r) => r[0]);
  }
}

// One temp dir per case with the cache reset once, so steps see cache hits and misses as in production.
async function readSteps(steps: any[]): Promise<unknown[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edl-'));
  try {
    resetEdlSidecarState();
    const out: unknown[] = [];
    for (const s of steps) {
      for (const [name, v] of Object.entries<any>(s.files)) {
        const p = path.join(dir, name);
        if (typeof v === 'string') fs.writeFileSync(p, v);
        else if (v.dir) fs.mkdirSync(p);
        else fs.writeFileSync(p, v.fill.repeat(v.size));
        if (s.mtime != null) fs.utimesSync(p, s.mtime, s.mtime);
      }
      out.push(await readEdlSidecar(path.join(dir, 'a.mkv'), s.fps));
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

emit('edl', [...specInputs, ...gen], run).then(() => console.log(`edl spec=${specCount} generated=${gen.length}`));
