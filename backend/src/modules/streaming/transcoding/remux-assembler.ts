import { watch, type FSWatcher } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Logger } from '@nestjs/common';
import { OUTPUT_POLL_MS } from './constants';
import type { RemuxRunStart } from './ffmpeg-args';
import { servedShift } from './source-timeline';
import {
  DECODE_TIME_TOLERANCE_SECONDS,
  type SegmentGrid,
} from './segment-boundaries';
import {
  firstTfdt,
  parseInitTracks,
  readInitEdits,
  retimeFragments,
  withInitEdits,
  type TrackInfo,
} from './timeline';

/** One AAC frame at its lowest sample rate (1024 / 8000 Hz): the longest
 *  priming our encoders put ahead of a run's first audio sample. */
const AUDIO_PRIMING_MAX_SECONDS = 1024 / 8000;

/** Tolerance when matching a GOP to the keyframe list: under a frame, above
 *  the output `-ss` rounding to a millisecond time base. */
const KEYFRAME_MATCH_SECONDS = 0.002;

/** Rename errors a scanner or indexer holding the file raises on Windows. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 5;

/** Passes, a poll apart, a segment may fail before the error is not a passing lock. */
const SEGMENT_ATTEMPTS = 3;

/** Edit each served track starts with, in seconds. */
export interface RemuxEdits {
  video: number;
  audio: number;
  /** Added to every source time: lifts a video that starts before 0 onto 0,
   *  as the transcoded variants are served (`servedShift`). */
  shift: number;
}

export interface RemuxAssemblyPlan {
  /** Session dir: receives `seg-NNNN.m4s` and `init.mp4`. */
  dir: string;
  /** Where this run's ffmpeg writes one file per GOP (`gop-<n>.m4s`) and its init. */
  gopDir: string;
  startSegment: number;
  /** ffmpeg's number for the run's first GOP file. */
  startNumber: number;
  /** The run's output `-ss` (0 for none): ffmpeg subtracts it from every
   *  timestamp, rounded to the source time base. */
  seekSeconds: number;
  /** GOP number of each segment's first GOP, then the GOP count; null when
   *  ffmpeg cuts the segments itself (no keyframe list). */
  firstGop: number[] | null;
  /** Presentation time of each GOP's keyframe, to find where the run landed. */
  gopPts: number[] | null;
  /** Source time the served timeline starts at. */
  start: number;
  /** Decode time of the first keyframe; null without a keyframe list, when the
   *  run's own init tells the reorder delay. */
  firstDecode: number | null;
}

/**
 * The edits of the served tracks: each takes back what the retime adds, so
 * presentation stays in source time. The video's is its first keyframe's
 * reorder delay, so a segment's tfdt is its first frame's time (what Shaka in
 * segments mode places it by); the audio's keeps its earliest sample, priming
 * ahead of the first keyframe's decode time, at or above 0.
 */
export function remuxEdits(start: number, firstDecode: number): RemuxEdits {
  const shift = servedShift({ origin: start });
  // The run from the start seeks this far under the first keyframe.
  const lowest = firstDecode - DECODE_TIME_TOLERANCE_SECONDS + shift;
  return {
    video: start - firstDecode,
    audio: Math.max(0, AUDIO_PRIMING_MAX_SECONDS - lowest),
    shift,
  };
}

export function remuxAssemblyPlan(o: {
  dir: string;
  gopDir: string;
  grid: SegmentGrid | null;
  startSegment: number;
  run: RemuxRunStart;
  origin: number;
}): RemuxAssemblyPlan {
  return {
    dir: o.dir,
    gopDir: o.gopDir,
    startSegment: o.startSegment,
    startNumber: o.run.startNumber,
    seekSeconds: o.run.seekSeconds ?? 0,
    firstGop: o.grid?.firstKeyframe ?? null,
    gopPts: o.grid?.keyframes.map((k) => k.pts) ?? null,
    start: o.grid ? o.grid.boundaries[0] : o.origin,
    firstDecode: o.grid?.keyframes[0]?.dts ?? null,
  };
}

/** The GOP files of `segment`, by ffmpeg number, or null past the end. */
function gopsOf(plan: RemuxAssemblyPlan, segment: number): number[] | null {
  if (!plan.firstGop) return [segment];
  if (segment + 1 >= plan.firstGop.length) return null;
  const out: number[] = [];
  for (let g = plan.firstGop[segment]; g < plan.firstGop[segment + 1]; g++) out.push(g);
  return out;
}

const segName = (n: number) => `seg-${String(n).padStart(4, '0')}.m4s`;

/**
 * Builds a remux run's served segments from the GOP files its ffmpeg writes,
 * each segment the concatenation of its grid GOPs moved onto the served
 * timeline, so its bytes and the shared init do not depend on the run.
 */
export class RemuxSegmentAssembler {
  private next: number;
  /** ffmpeg GOP number → grid GOP index. */
  private gopOffset = 0;
  private delta: Map<number, bigint> | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly plan: RemuxAssemblyPlan,
    private readonly log: Logger,
    private readonly label: string,
    /** Called once assembly gave up: the run's output can no longer be served. */
    private readonly onFailure: (err: Error) => void = () => {},
  ) {
    this.next = plan.startSegment;
  }

  start(): void {
    try {
      // Writes into a GOP file raise `change`; a file appearing is a `rename`.
      this.watcher = watch(this.plan.gopDir, { persistent: false }, (event) => {
        if (event === 'rename') this.kick();
      });
    } catch (err) {
      this.log.warn(`[${this.label}] cannot watch ${this.plan.gopDir}: ${(err as Error).message}`);
    }
    this.timer = setInterval(() => this.kick(), OUTPUT_POLL_MS);
  }

  /** ffmpeg exited. A run that ended cleanly also completes the last segment:
   *  only then is its last GOP known whole. The GOP files go either way. */
  async finish(exitedCleanly: boolean): Promise<void> {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    this.kick();
    await this.chain;
    if (exitedCleanly && !this.stopped) {
      await this.assembleTail().catch((err: Error) =>
        this.log.error(`[${this.label}] last segment ${this.next} not assembled: ${err.message}`),
      );
    }
    await fsp.rm(this.plan.gopDir, { recursive: true, force: true });
  }

  private kick(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    this.chain = this.chain
      .then(() => {
        this.queued = false;
        return this.pump();
      })
      .catch((err: Error) => this.failed(err));
  }

  private failed(err: Error): void {
    if (++this.failures < SEGMENT_ATTEMPTS) {
      this.log.warn(
        `[${this.label}] segment ${this.next} not assembled (attempt ${this.failures}): ${err.message}`,
      );
      return;
    }
    this.stopped = true;
    this.log.error(`[${this.label}] remux assembly stopped at segment ${this.next}: ${err.message}`);
    this.onFailure(err);
  }

  private gopPath(gop: number): string {
    return path.join(this.plan.gopDir, `gop-${gop - this.gopOffset}.m4s`);
  }

  private async exists(p: string): Promise<boolean> {
    return fsp.access(p).then(
      () => true,
      () => false,
    );
  }

  /** The GOP after `gop` has started: the muxer renames a GOP it cuts short at
   *  exit too, so only that proves `gop` whole. */
  private async followed(gop: number): Promise<boolean> {
    const after = this.gopPath(gop + 1);
    return (await this.exists(`${after}.tmp`)) || this.exists(after);
  }

  private async pump(): Promise<void> {
    if (!this.delta && !(await this.openRun())) return;
    for (;;) {
      const gops = gopsOf(this.plan, this.next);
      if (!gops || !(await this.followed(gops[gops.length - 1]))) return;
      await this.assemble(this.next, gops);
      this.next++;
      this.failures = 0;
    }
  }

  /** Once the run's first GOP is out: its init is complete, and where the
   *  demuxer really landed is known. */
  private async openRun(): Promise<boolean> {
    const first = path.join(this.plan.gopDir, `gop-${this.plan.startNumber}.m4s`);
    if (!(await this.exists(first))) return false;
    const init = await fsp.readFile(path.join(this.plan.gopDir, 'init.mp4'));
    const tracks = parseInitTracks(init);
    const runEdits = readInitEdits(init);
    const gop = await fsp.readFile(first);
    const correction = this.locateRun(gop, tracks);
    const video = [...tracks].find(([, t]) => t.isVideo);
    const runVideoEdit = video ? Number(runEdits.get(video[0]) ?? 0n) / video[1].timescale : 0;
    const edits = remuxEdits(
      this.plan.start,
      this.plan.firstDecode ?? this.plan.start - runVideoEdit,
    );
    const editOf = (t: TrackInfo) => (t.isVideo ? edits.video : edits.audio);
    const delta = new Map<number, bigint>();
    for (const [id, t] of tracks) {
      const shift = Math.round((editOf(t) + edits.shift + correction) * t.timescale);
      let d = BigInt(shift) - (runEdits.get(id) ?? 0n);
      // A first frame at 0 whose derived decode time is a tick off.
      const start = firstTfdt(gop, id);
      if (start != null && start + d < 0n) {
        this.log.warn(`[${this.label}] track ${id} starts ${-(start + d)} ticks before 0; moved to 0`);
        d = -start;
      }
      delta.set(id, d);
    }
    const out = path.join(this.plan.dir, 'init.mp4');
    if (!(await this.exists(out))) {
      await writeAtomic(out, withInitEdits(init, editOf));
    }
    this.delta = delta;
    this.failures = 0;
    return true;
  }

  /** What to add to the run's timestamps to get source time: the output `-ss`
   *  as ffmpeg rounded it, found by matching the run's first GOP, whose tfdt
   *  under `frag_discont` is its keyframe's pts less that `-ss`. */
  private locateRun(
    gop: Buffer,
    tracks: ReturnType<typeof parseInitTracks>,
  ): number {
    const { gopPts, firstGop, startNumber, startSegment, seekSeconds } = this.plan;
    if (!gopPts || !firstGop) return seekSeconds;
    const video = [...tracks].find(([, t]) => t.isVideo);
    const tfdt = video && firstTfdt(gop, video[0]);
    if (!video || tfdt == null) throw new Error('first GOP has no video fragment');
    const out = Number(tfdt) / video[1].timescale;
    const pts = out + seekSeconds;
    const at = gopPts.findIndex((p) => Math.abs(p - pts) < KEYFRAME_MATCH_SECONDS);
    if (at < 0) throw new Error(`first GOP starts at ${pts}s, on no source keyframe`);
    if (at !== startNumber) {
      this.gopOffset = at - startNumber;
      while (this.next + 1 < firstGop.length && firstGop[this.next] < at) this.next++;
      this.log.warn(
        `[${this.label}] run meant for segment ${startSegment} landed on GOP ${at} (planned ${startNumber}); assembling from segment ${this.next}`,
      );
    }
    return gopPts[at] - out;
  }

  /** One GOP in memory at a time. A segment another run already built stays:
   *  it holds the same samples on the same timeline, and may have been served. */
  private async assemble(segment: number, gops: number[]): Promise<void> {
    const out = path.join(this.plan.dir, segName(segment));
    if (!(await this.exists(out))) {
      const tmp = `${out}.tmp`;
      const fh = await fsp.open(tmp, 'w');
      try {
        for (const g of gops) {
          await fh.write(retimeFragments(await fsp.readFile(this.gopPath(g)), this.delta!));
        }
      } finally {
        await fh.close();
      }
      await renameRetrying(tmp, out);
    }
    await Promise.all(gops.map((g) => fsp.rm(this.gopPath(g), { force: true })));
  }

  /** The last segment of a run that ended cleanly, from the GOPs written. */
  private async assembleTail(): Promise<void> {
    const gops = gopsOf(this.plan, this.next);
    if (!this.delta || !gops) return;
    const written: number[] = [];
    for (const g of gops) if (await this.exists(this.gopPath(g))) written.push(g);
    if (written.length === 0) return;
    if (written.length < gops.length) {
      this.log.warn(
        `[${this.label}] last segment ${this.next}: ${written.length} of ${gops.length} planned GOPs were written`,
      );
    }
    await this.assemble(this.next, written);
  }
}

async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, OUTPUT_POLL_MS / RENAME_ATTEMPTS));
    }
  }
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data);
  await renameRetrying(tmp, file);
}
