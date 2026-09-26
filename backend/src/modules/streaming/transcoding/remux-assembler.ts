import { watch, type FSWatcher } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { Logger } from '@nestjs/common';
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

/** Without a keyframe list, how far ahead of the timeline origin the first
 *  keyframe's decode time is allowed to sit (B-frame reorder). */
const UNPROBED_REORDER_SECONDS = 1;

/** Tolerance when matching a GOP to the keyframe list: under a frame, above
 *  the output `-ss` rounding to a millisecond time base. */
const KEYFRAME_MATCH_SECONDS = 0.002;

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
  edits: RemuxEdits;
}

/**
 * The edits of the served tracks. A served tfdt is its sample's source decode
 * time plus its track's edit, which the edit takes back off, so presentation
 * stays in source time. The video's is its first keyframe's reorder delay, so a
 * segment's tfdt is its first frame's time (for a constant delay), which is
 * what a player placing each segment by its tfdt against the playlist (Shaka in
 * segments mode) expects. The audio's keeps its earliest sample, priming ahead
 * of the first keyframe's decode time, at or above 0.
 */
export function remuxEdits(
  grid: SegmentGrid | null,
  origin: number,
): RemuxEdits {
  const start = grid ? grid.boundaries[0] : origin;
  const firstDecode =
    grid?.keyframes[0]?.dts ?? start - UNPROBED_REORDER_SECONDS;
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
    edits: remuxEdits(o.grid, o.origin),
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
 * Builds a remux run's served segments from the GOP files its ffmpeg writes:
 * each segment is the concatenation of its grid GOPs, so its bytes do not
 * depend on where the run started. Every fragment is moved onto the served
 * timeline (source decode time plus the shared edit) and the init gets that
 * edit on every track, so all runs share one init.
 */
export class RemuxSegmentAssembler {
  private next: number;
  /** ffmpeg GOP number → grid GOP index. */
  private gopOffset = 0;
  private delta: Map<number, bigint> | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly plan: RemuxAssemblyPlan,
    private readonly log: Logger,
    private readonly label: string,
  ) {
    this.next = plan.startSegment;
  }

  start(): void {
    try {
      this.watcher = watch(this.plan.gopDir, { persistent: false }, () =>
        this.kick(),
      );
    } catch (err) {
      this.log.warn(`[${this.label}] cannot watch ${this.plan.gopDir}: ${(err as Error).message}`);
    }
    this.timer = setInterval(() => this.kick(), 500);
  }

  /** ffmpeg exited. A run that reached the end also completes the last
   *  segment with the GOPs it wrote. The GOP files go either way. */
  async finish(reachedEnd: boolean): Promise<void> {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
    this.kick();
    await this.chain;
    if (reachedEnd) await this.assembleTail();
    await fsp.rm(this.plan.gopDir, { recursive: true, force: true });
  }

  private kick(): void {
    this.chain = this.chain.then(() => this.pump()).catch((err: Error) => {
      this.failed = true;
      this.log.error(`[${this.label}] remux assembly stopped: ${err.message}`);
    });
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

  private async pump(): Promise<void> {
    if (this.failed) return;
    if (!this.delta && !(await this.openRun())) return;
    for (;;) {
      const gops = gopsOf(this.plan, this.next);
      if (!gops) return;
      for (const g of gops) if (!(await this.exists(this.gopPath(g)))) return;
      await this.assemble(this.next, gops);
      this.next++;
    }
  }

  /** Once the run's first GOP is out: its init is complete, and where the
   *  demuxer really landed is known. */
  private async openRun(): Promise<boolean> {
    const first = path.join(this.plan.gopDir, `gop-${this.plan.startNumber}.m4s`);
    if (!(await this.exists(first))) return false;
    const init = await fsp.readFile(path.join(this.plan.gopDir, 'init.mp4'));
    const tracks = parseInitTracks(init);
    const edits = readInitEdits(init);
    const gop = await fsp.readFile(first);
    const correction = this.locateRun(gop, tracks);
    const editOf = (t: TrackInfo) => (t.isVideo ? this.plan.edits.video : this.plan.edits.audio);
    const delta = new Map<number, bigint>();
    for (const [id, t] of tracks) {
      const shift = Math.round(
        (editOf(t) + this.plan.edits.shift + correction) * t.timescale,
      );
      let d = BigInt(shift) - (edits.get(id) ?? 0n);
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
    return true;
  }

  /**
   * Match the run's first GOP to the keyframe list; under `frag_discont` its
   * first tfdt is that keyframe's presentation time less the output `-ss`.
   * Returns what to add to the run's timestamps to get source time: the `-ss`
   * as ffmpeg rounded it to the source time base.
   */
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

  private async assemble(segment: number, gops: number[]): Promise<void> {
    const parts: Buffer[] = [];
    for (const g of gops) parts.push(retimeFragments(await fsp.readFile(this.gopPath(g)), this.delta!));
    await writeAtomic(path.join(this.plan.dir, segName(segment)), Buffer.concat(parts));
    await Promise.all(gops.map((g) => fsp.rm(this.gopPath(g), { force: true })));
  }

  /** The last segment of a run that reached the end, from the GOPs written. */
  private async assembleTail(): Promise<void> {
    const gops = gopsOf(this.plan, this.next);
    if (this.failed || !this.delta || !gops) return;
    const written: number[] = [];
    for (const g of gops) if (await this.exists(this.gopPath(g))) written.push(g);
    if (written.length === 0) return;
    this.log.warn(
      `[${this.label}] last segment ${this.next}: ${written.length} of ${gops.length} planned GOPs were written`,
    );
    await this.assemble(this.next, written);
  }
}

async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
