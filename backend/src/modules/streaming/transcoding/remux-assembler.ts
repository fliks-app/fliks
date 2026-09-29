import * as fsp from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import type { Logger } from '@nestjs/common';
import { writeAtomically, writeFileAtomic } from '../../../common/utils/atomic-file';
import type { RemuxRunStart } from './ffmpeg-args';
import { servedShift } from './source-timeline';
import {
  DEFAULT_SEGMENT_DURATION,
  REMUX_MAX_WAIT_SEGMENTS,
  REMUX_WAIT_BUFFER_SECONDS,
} from './constants';
import { type KeyframeGrid } from './segment-boundaries';
import { watchDir } from './segment-utils';
import {
  findBox,
  firstTfdt,
  makeBox,
  parseInitTracks,
  parseTrexDefaults,
  readBoxHeader,
  readInitEdits,
  readTfdt,
  retimeFragments,
  TRUN_DATA_OFFSET,
  TRUN_SAMPLE_CTS,
  TRUN_SAMPLE_DURATION,
  TRUN_SAMPLE_FLAGS,
  TRUN_SAMPLE_SIZE,
  trunSamples,
  u32,
  videoDecodeExtent,
  withInitEdits,
  type Box,
  type RawSample,
  type TrackInfo,
} from './timeline';

/** Tolerance when matching a GOP to the keyframe list: under a frame, above
 *  the output `-ss` rounding to a millisecond time base. */
const KEYFRAME_MATCH_SECONDS = 0.002;

/** Media data is copied through this much at a time, never a whole GOP. */
const COPY_CHUNK_BYTES = 1 << 20;

/** Passes, a poll apart, a segment may fail before the error is not a passing lock. */
const SEGMENT_ATTEMPTS = 3;

/** Edit the served video track starts with, in seconds; audio's own is
 *  read per-track from the run's real encoder delay ({@link audioEditSeconds}). */
export interface RemuxEdits {
  video: number;
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
  /** Decode time of each GOP's keyframe: an open-GOP source's keyframes don't
   *  share one pts-dts offset, unlike `gopPts` under a single `correction`. */
  gopDts: number[] | null;
  /** Source time the served timeline starts at. */
  start: number;
  /** Decode time of the first keyframe; null without a keyframe list, when the
   *  run's own init tells the reorder delay. */
  firstDecode: number | null;
  /** Grid segment boundaries (source seconds, `KeyframeGrid.boundaries`);
   *  null on the uniform fallback, where audio is still grouped by time
   *  (`segmentDuration` multiples from `startNumber`), just not the video. */
  boundaries: number[] | null;
  /** Nominal segment duration (seconds): the uniform fallback's audio
   *  grouping grid when `boundaries` is null. */
  segmentDuration: number;
  /** Extra audio-only renditions sharing this run, each ffmpeg's own
   *  `a<i>.mp4` (0-based); 0 for the single-rendition inline layout. */
  audioRenditions: number;
}

/** The video's reorder delay makes a served segment's tfdt its first frame
 *  (Shaka places segments by it, ignoring the edit list). */
export function remuxEdits(start: number, firstDecode: number): RemuxEdits {
  return { video: start - firstDecode, shift: servedShift({ origin: start }) };
}

/** A non-video track's edit, in seconds: its run's own encoder delay, so its raw tfdt
 *  stays within the video's (Shaka aligns tracks on raw tfdt, not the edit list). */
function audioEditSeconds(runEdits: Map<number, bigint>, id: number, timescale: number): number {
  return Math.max(0, Number(runEdits.get(id) ?? 0n)) / timescale;
}

export function remuxAssemblyPlan(o: {
  dir: string;
  gopDir: string;
  grid: KeyframeGrid | null;
  startSegment: number;
  run: RemuxRunStart;
  origin: number;
  /** See {@link RemuxAssemblyPlan.segmentDuration}. Defaults to
   *  {@link DEFAULT_SEGMENT_DURATION}. */
  segmentDuration?: number;
  /** See {@link RemuxAssemblyPlan.audioRenditions}. */
  audioRenditions?: number;
}): RemuxAssemblyPlan {
  return {
    dir: o.dir,
    gopDir: o.gopDir,
    startSegment: o.startSegment,
    startNumber: o.run.startNumber,
    seekSeconds: o.run.seekSeconds ?? 0,
    firstGop: o.grid?.firstKeyframe ?? null,
    gopPts: o.grid?.keyframes.map((k) => k.pts) ?? null,
    gopDts: o.grid?.keyframes.map((k) => k.dts) ?? null,
    start: o.grid ? o.grid.boundaries[0] : o.origin,
    firstDecode: o.grid?.keyframes[0]?.dts ?? null,
    boundaries: o.grid?.boundaries ?? null,
    segmentDuration: o.segmentDuration ?? DEFAULT_SEGMENT_DURATION,
    audioRenditions: o.audioRenditions ?? 0,
  };
}

/** Segment `i`'s planned source-time boundary: the real grid boundary, or
 *  (uniform fallback) `segmentDuration` multiples from the plan's origin. */
function planBoundarySeconds(
  plan: Pick<RemuxAssemblyPlan, 'boundaries' | 'start' | 'segmentDuration'>,
  i: number,
): number {
  const { boundaries, start, segmentDuration } = plan;
  return boundaries ? boundaries[Math.min(i, boundaries.length - 1)] : start + i * segmentDuration;
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

/** One audio-only rendition's assembly state: ffmpeg writes it as a single
 *  growing fragmented mp4, one frame per fragment (`frag_every_frame`; its
 *  own segmenting would be meaningless at `hls_time=0` on a stream with no
 *  video reference, cutting on literally every packet), which this tails and
 *  groups onto the video's grid by each fragment's own decode time. */
interface AudioRendition {
  /** 1-based served EXT-X-MEDIA index (the streaming controller's contract);
   *  ffmpeg's own raw file is `a<index - 1>.mp4`, 0-based on `-map 0:a:i`. */
  index: number;
  /** Served dir: `plan.dir/<index>`. */
  dir: string;
  /** ffmpeg's raw growing output: `plan.gopDir/a<index - 1>.mp4`. */
  file: string;
  /** Next unread byte of `file`. */
  offset: number;
  trackId: number | null;
  timescale: number;
  /** Ticks added to this track's tfdt onto the served timeline; resolved once
   *  from the run's init, like the single-track `delta` map entry. */
  delta: bigint | null;
  /** `delta` was clamped against a first-frame-before-0 tick once already. */
  deltaClamped: boolean;
  /** `correction` (run-local → source time), in this track's own timescale
   *  ticks: integer, so a grouping decision never flips on float noise. */
  correctionTicks: bigint;
  /** Next served segment index to close; -1 until the run's landing point
   *  is known ({@link RemuxSegmentAssembler.openRun}'s `locateRun`). */
  served: number;
  /** Frames accumulated for `served`, not yet flushed. */
  pending: RawFrame[];
  /** Consecutive assembly failures, isolated from the video's own counter
   *  and from every other rendition's own. */
  failures: number;
}

/** Builds a run's served segments from its GOP files on the grid and the served
 *  timeline, so segments and the shared init do not depend on the run. A
 *  multi-audio run also assembles every {@link AudioRendition} sharing it. */
export class RemuxSegmentAssembler {
  private next: number;
  /** ffmpeg GOP number → grid GOP index. */
  private gopOffset = 0;
  private delta: Map<number, bigint> | null = null;
  /** The run's video track and what adds to its tfdt to give source time. */
  private video: {
    id: number;
    timescale: number;
    correction: number;
    /** Same run-to-source shift in decode time: unlike `correction`, valid at
     *  any keyframe regardless of its own pts-dts offset. */
    dtsCorrection: number;
    /** `trex` default duration, for a sample whose trun and tfhd give none. */
    trexDefault: number;
  } | null = null;
  private readonly chunk = Buffer.alloc(COPY_CHUNK_BYTES);
  private unwatch: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private queued = false;
  private failures = 0;
  private stopped = false;
  /** Set once the run's landing point is known (end of {@link openRun}); gates
   *  the frontier getters below, which are meaningless before then. */
  private opened = false;
  private openedAt: number | null = null;
  /** `this.next` once the run opened: the baseline `segmentsPerSecond`
   *  measures progress from. */
  private openStartSegment = 0;
  /** Wall-clock ms spent throttle-paused so far; excluded from
   *  {@link segmentsPerSecond} so a pause doesn't read back as a slow run. */
  private pausedMs = 0;
  private pausedSince: number | null = null;

  /** Maps run-local time to source-pts time (the same space `boundaries`
   *  is in); resolved once video's own run lands, shared by every audio
   *  rendition's boundary comparison. */
  private correction: number | null = null;
  private edits: RemuxEdits | null = null;
  private readonly audio: AudioRendition[];

  constructor(
    private readonly plan: RemuxAssemblyPlan,
    private readonly log: Logger,
    private readonly label: string,
    /** Called once assembly gave up: the run's output can't be served. */
    private readonly onFailure: (err: Error) => void = () => {},
  ) {
    this.next = plan.startSegment;
    this.audio = [];
    for (let i = 1; i <= plan.audioRenditions; i++) {
      this.audio.push({
        index: i,
        dir: path.join(plan.dir, String(i)),
        file: path.join(plan.gopDir, `a${i - 1}.mp4`),
        offset: 0,
        trackId: null,
        timescale: 0,
        delta: null,
        deltaClamped: false,
        correctionTicks: 0n,
        served: -1,
        pending: [],
        failures: 0,
      });
    }
  }

  /** One dir holds both the video GOPs and every track's growing file: a
   *  single watcher, no per-rendition subdir that ffmpeg hasn't made yet. */
  start(): void {
    this.unwatch = watchDir(
      this.plan.gopDir,
      // Writes into a file raise `change`; a file appearing is a `rename`.
      (event) => event !== 'change' && this.kick(),
      (err) => this.log.warn(`[${this.label}] cannot watch ${this.plan.gopDir}: ${err.message}`),
    );
  }

  /** ffmpeg exited. A run that ended cleanly also completes the last segment:
   *  only then is its last GOP known whole. The GOP files go either way. */
  async finish(exitedCleanly: boolean): Promise<void> {
    this.unwatch?.();
    this.kick();
    await this.chain;
    if (exitedCleanly && !this.stopped) {
      await this.assembleTail().catch((err: Error) =>
        this.log.error(`[${this.label}] last segment ${this.next} not assembled: ${err.message}`),
      );
      for (const a of this.audio) {
        await this.assembleAudioTail(a).catch((err: Error) =>
          this.log.error(`[${this.label}] audio rendition ${a.index} tail not assembled: ${err.message}`),
        );
      }
    }
    await fsp.rm(this.plan.gopDir, { recursive: true, force: true });
  }

  /** Segment this run has yet to produce (below it, all are on disk).
   *  Null before the run's first GOP has landed ({@link openRun}). */
  videoFrontier(): number | null {
    return this.opened ? this.next : null;
  }

  /** Same as {@link videoFrontier}, for one rendition (1-based served
   *  EXT-X-MEDIA index). Null before open, or with no such rendition. */
  audioFrontier(index: number): number | null {
    if (!this.opened) return null;
    return this.audio.find((a) => a.index === index)?.served ?? null;
  }

  /** Segments/second since open, excluding paused time: a long pause must
   *  not read back as a slow run and shrink {@link canServe}'s wait window. */
  segmentsPerSecond(): number | null {
    if (!this.opened || this.openedAt == null) return null;
    const pausedMs =
      this.pausedMs + (this.pausedSince != null ? Date.now() - this.pausedSince : 0);
    const elapsedSeconds = (Date.now() - this.openedAt - pausedMs) / 1000;
    if (elapsedSeconds <= 0) return null;
    return (this.next - this.openStartSegment) / elapsedSeconds;
  }

  /** Content-time boundary of the frontier segment (source time less the
   *  plan's origin, matching `LiveSession.position`). Null before landing. */
  frontierSeconds(): number | null {
    return this.opened ? this.segmentContentSeconds(this.next) : null;
  }

  /** Content-time start of the run's first assembled segment. Null before
   *  landing. */
  runStartSeconds(): number | null {
    return this.opened ? this.segmentContentSeconds(this.openStartSegment) : null;
  }

  /** Content-time start of served segment `i`, on the keyframe grid's real
   *  spacing: shared by {@link frontierSeconds} and the throttle service. */
  segmentContentSeconds(i: number): number {
    return planBoundarySeconds(this.plan, i) - this.plan.start;
  }

  /** Freeze the throughput clock: called when the throttle service stops
   *  this run's ffmpeg. Idempotent. */
  pause(): void {
    if (this.pausedSince == null) this.pausedSince = Date.now();
  }

  /** Resume the throughput clock. Idempotent. */
  resume(): void {
    if (this.pausedSince != null) {
      this.pausedMs += Date.now() - this.pausedSince;
      this.pausedSince = null;
    }
  }

  /** Whether `segment` (the video, or one rendition with `audioIndex`) is
   *  servable now: a live run gets a throughput-sized wait window, an exited one a hard boundary. */
  canServe(segment: number, audioIndex: number | undefined, exited: boolean): boolean {
    const frontier = audioIndex != null ? this.audioFrontier(audioIndex) : this.videoFrontier();
    const start = this.plan.startSegment;
    if (exited) return frontier != null && segment >= start && segment < frontier;
    if (segment < start) return false;
    const perSecond = this.segmentsPerSecond();
    const waitWindow =
      perSecond == null
        ? REMUX_MAX_WAIT_SEGMENTS
        : Math.min(REMUX_MAX_WAIT_SEGMENTS, Math.max(1, Math.round(perSecond * REMUX_WAIT_BUFFER_SECONDS)));
    return frontier == null ? segment - start <= waitWindow : segment <= frontier + waitWindow;
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

  /** Complete once its video decode reaches the next keyframe's time on the
   *  grid (the last GOP: the video's end), whichever way ffmpeg exited. */
  private async isComplete(gop: number): Promise<boolean> {
    const file = this.gopPath(gop);
    if (!(await this.exists(file))) return false;
    const { gopDts, boundaries } = this.plan;
    // Uniform fallback: no grid to prove decode position against, so a
    // rename (the muxer's own segment-closed signal) is all there is.
    if (!gopDts || !boundaries || !this.video) return true;
    const extent = videoDecodeExtent(await readMoofs(file), this.video.id, this.video.trexDefault);
    if (!extent) return false;
    // The next keyframe's own decode time: its pts-dts offset (open-GOP CRA vs
    // IDR) doesn't cancel out through the single pts-domain `correction`.
    const targetTicks =
      gop + 1 < gopDts.length
        ? BigInt(Math.round((gopDts[gop + 1] - this.video.dtsCorrection) * this.video.timescale))
        : BigInt(
            Math.round((boundaries[boundaries.length - 1] - this.video.correction) * this.video.timescale),
          );
    return extent.end + extent.lastDuration / 2n >= targetTicks;
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (!this.delta && !(await this.openRun())) return;
    for (;;) {
      const gops = gopsOf(this.plan, this.next);
      if (!gops || !(await this.isComplete(gops[gops.length - 1]))) break;
      await this.assemble(this.next, gops);
      this.next++;
      this.failures = 0;
    }
    for (const a of this.audio) {
      if (this.stopped) break;
      await this.pumpAudio(a);
    }
  }

  /** Once the run's first GOP is out: its init is complete, and where the
   *  demuxer really landed is known. */
  private async openRun(): Promise<boolean> {
    const first = this.gopPath(this.plan.startNumber);
    if (!(await this.exists(first))) return false;
    const init = await fsp.readFile(path.join(this.plan.gopDir, 'init.mp4'));
    const tracks = parseInitTracks(init);
    const runEdits = readInitEdits(init);
    const gop = await readMoofs(first);
    const { correction, dtsCorrection } = this.locateRun(gop, tracks);
    const video = [...tracks].find(([, t]) => t.isVideo);
    const trex = parseTrexDefaults(init);
    this.video = video
      ? {
          id: video[0],
          timescale: video[1].timescale,
          correction,
          dtsCorrection,
          trexDefault: trex.get(video[0]) ?? 0,
        }
      : null;
    const runVideoEdit = video ? Number(runEdits.get(video[0]) ?? 0n) / video[1].timescale : 0;
    const edits = remuxEdits(
      this.plan.start,
      this.plan.firstDecode ?? this.plan.start - runVideoEdit,
    );
    this.edits = edits;
    this.correction = correction;
    const editOf = (id: number, t: TrackInfo) =>
      t.isVideo ? edits.video : audioEditSeconds(runEdits, id, t.timescale);
    const delta = new Map<number, bigint>();
    for (const [id, t] of tracks) {
      const shift = Math.round((editOf(id, t) + edits.shift + correction) * t.timescale);
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
      await writeFileAtomic(out, withInitEdits(init, editOf));
    }
    this.delta = delta;
    this.failures = 0;
    // A run that landed past its planned segment (above) must not let an
    // audio rendition persist a segment before it: start where video did.
    for (const a of this.audio) a.served = this.next;
    this.opened = true;
    this.openedAt = Date.now();
    this.openStartSegment = this.next;
    return true;
  }

  /** The output `-ss` as ffmpeg rounded it, found by matching the first GOP's tfdt
   *  (its keyframe's pts less the `-ss`, under `frag_discont`) to a keyframe. */
  private locateRun(
    gop: Buffer,
    tracks: ReturnType<typeof parseInitTracks>,
  ): { correction: number; dtsCorrection: number } {
    const { gopPts, gopDts, firstGop, startNumber, startSegment, seekSeconds } = this.plan;
    if (!gopPts || !gopDts || !firstGop) {
      return { correction: seekSeconds, dtsCorrection: seekSeconds };
    }
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
    return { correction: gopPts[at] - out, dtsCorrection: gopDts[at] - out };
  }

  /** A segment another run already built stays: it holds the same samples on
   *  the same timeline, and may have been served. */
  private async assemble(segment: number, gops: number[]): Promise<void> {
    const out = path.join(this.plan.dir, segName(segment));
    if (!(await this.exists(out))) {
      await writeAtomically(out, async (tmp) => {
        const fh = await fsp.open(tmp, 'w');
        try {
          for (const g of gops) await this.appendGop(fh, g);
        } finally {
          await fh.close();
        }
      });
    }
    await Promise.all(gops.map((g) => fsp.rm(this.gopPath(g), { force: true })));
  }

  /** GOP `g` onto `out`: its fragment headers retimed, its media data copied
   *  through. */
  private async appendGop(out: FileHandle, g: number): Promise<void> {
    const src = await fsp.open(this.gopPath(g), 'r');
    try {
      let checked = false;
      for await (const box of topBoxes(src)) {
        if (!box.moof) {
          await copyRange(src, out, box.start, box.size, this.chunk);
          continue;
        }
        if (!checked) checked = this.checkGop(g, box.moof);
        await out.write(retimeFragments(box.moof, this.delta!));
      }
      if (!checked) throw new Error(`GOP ${g} has no video fragment`);
    } finally {
      await src.close();
    }
  }

  /** Whether `moof` opens GOP `g`'s video; throws when it opens another GOP,
   *  whose samples a file matched by number alone would serve. The muxer's
   *  decode clock drifts off the source's, so `g` must be the nearest keyframe. */
  private checkGop(g: number, moof: Buffer): boolean {
    const { gopPts } = this.plan;
    if (!this.video) return true;
    const tfdt = firstTfdt(moof, this.video.id);
    if (tfdt == null) return false;
    if (!gopPts) return true;
    const at = Number(tfdt) / this.video.timescale + this.video.correction;
    const off = (k: number) => Math.abs(at - gopPts[k]);
    const nearer = [g - 1, g + 1].find((k) => k >= 0 && k < gopPts.length && off(k) < off(g));
    if (nearer !== undefined) {
      throw new Error(
        `GOP file ${g - this.gopOffset} starts at ${at.toFixed(3)}s, on keyframe ${nearer} (${gopPts[nearer]}s), not the planned ${g} (${gopPts[g]}s)`,
      );
    }
    return true;
  }

  /** The last segment of a run that ended cleanly, from the GOPs written. */
  private async assembleTail(): Promise<void> {
    const gops = gopsOf(this.plan, this.next);
    if (!this.delta || !gops) return;
    const written: number[] = [];
    for (const g of gops) if (await this.exists(this.gopPath(g))) written.push(g);
    // A clean exit code proves nothing about the last GOP: a killed service
    // manager can SIGTERM ffmpeg itself, whose trailer renames it anyway.
    if (written.length > 0 && !(await this.isComplete(written[written.length - 1]))) {
      written.pop();
    }
    if (written.length === 0) return;
    if (written.length < gops.length) {
      this.log.warn(
        `[${this.label}] last segment ${this.next}: ${written.length} of ${gops.length} planned GOPs were complete`,
      );
    }
    await this.assemble(this.next, written);
    // Mirrors the pump loop's own `this.next++`: frontier getters below are
    // "one past the last produced segment" in both the running and exited case.
    this.next++;
  }

  // ── Audio renditions ────────────────────────────────────────────────────

  /** Resolve `a`'s own track + per-run delta from its growing file's init
   *  (ftyp+moov), once ffmpeg has written one (`delay_moov`: after its first
   *  frame). Mirrors {@link openRun}'s per-track math for the audio edit,
   *  applied to this rendition's lone track. */
  private async openAudioRun(a: AudioRendition): Promise<boolean> {
    if (!(await this.exists(a.file))) return false;
    const boxes = await tailBoxes(a.file, 0);
    const moov = boxes.find((b) => b.type === 'moov');
    if (!moov) return false;
    const moovEnd = moov.start + moov.size;
    const init = Buffer.concat(boxes.filter((b) => b.start < moovEnd).map((b) => b.buf));
    const entry = [...parseInitTracks(init)][0];
    if (!entry) {
      throw new Error(`audio rendition ${a.index} init has no parseable track`);
    }
    if (this.edits == null || this.correction == null) {
      throw new Error(`audio rendition ${a.index}: video run not resolved yet`);
    }
    const [trackId, info] = entry;
    const runEdits = readInitEdits(init);
    a.trackId = trackId;
    a.timescale = info.timescale;
    a.correctionTicks = BigInt(Math.round(this.correction * info.timescale));
    const edit = audioEditSeconds(runEdits, trackId, info.timescale);
    const shift = Math.round((edit + this.edits.shift + this.correction) * info.timescale);
    a.delta = BigInt(shift) - (runEdits.get(trackId) ?? 0n);
    a.offset = moovEnd;
    await fsp.mkdir(a.dir, { recursive: true });
    const out = path.join(a.dir, `init_${a.index}.mp4`);
    if (!(await this.exists(out))) {
      await writeFileAtomic(out, withInitEdits(init, () => edit));
    }
    return true;
  }

  /** Every complete (moof, mdat) pair past `a.offset`, with the offset past it
   *  for the caller to commit once consumed; a trailing unpaired moof waits. */
  private async readAudioFrames(a: AudioRendition): Promise<{ frame: RawFrame; offset: number }[]> {
    const boxes = await tailBoxes(a.file, a.offset);
    const frames: { frame: RawFrame; offset: number }[] = [];
    let i = 0;
    while (i + 1 < boxes.length && boxes[i].type === 'moof' && boxes[i + 1].type === 'mdat') {
      frames.push({
        frame: parseFrame(boxes[i].buf, boxes[i + 1].buf),
        offset: boxes[i + 1].start + boxes[i + 1].size,
      });
      i += 2;
    }
    return frames;
  }

  /** Segment `i`'s planned source-time boundary, in integer ticks so two runs
   *  never disagree on float noise; never this run's own drifting landing point. */
  private boundaryTicks(a: AudioRendition, i: number): bigint {
    return BigInt(Math.round(planBoundarySeconds(this.plan, i) * a.timescale));
  }

  private hasMoreSegments(a: AudioRendition): boolean {
    const boundaries = this.plan.boundaries;
    return !boundaries || a.served + 1 < boundaries.length;
  }

  /** Group one frame onto the served segment its (retimed) decode time falls
   *  in. A seeked run's leading priming is dropped, not pushed onto a segment
   *  an earlier run already served; segment 0 has none to protect, so it's kept. */
  private async groupAudioFrame(a: AudioRendition, frame: RawFrame): Promise<void> {
    const absTicks = frame.tfdt + a.correctionTicks;
    if (a.served > 0 && absTicks < this.boundaryTicks(a, a.served)) return;
    while (this.hasMoreSegments(a) && absTicks >= this.boundaryTicks(a, a.served + 1)) {
      await this.flushAudioPending(a);
    }
    if (this.hasMoreSegments(a)) a.pending.push(frame);
  }

  /** Read and group every frame `a`'s file has ready, isolating failures to
   *  this one rendition: one stalled track must not share, reset or
   *  masquerade as the video's own failure counter. */
  private async pumpAudio(a: AudioRendition): Promise<void> {
    if (this.stopped) return;
    try {
      await this.pumpAudioFrames(a);
      a.failures = 0;
    } catch (err) {
      this.audioFailed(a, err as Error);
    }
  }

  private audioFailed(a: AudioRendition, err: Error): void {
    if (++a.failures < SEGMENT_ATTEMPTS) {
      this.log.warn(
        `[${this.label}] audio rendition ${a.index} segment ${a.served} not assembled (attempt ${a.failures}): ${err.message}`,
      );
      return;
    }
    this.stopped = true;
    this.log.error(
      `[${this.label}] audio rendition ${a.index} assembly stopped at segment ${a.served}: ${err.message}`,
    );
    this.onFailure(err);
  }

  private async pumpAudioFrames(a: AudioRendition): Promise<void> {
    if (a.delta == null && !(await this.openAudioRun(a))) return;
    for (const { frame, offset } of await this.readAudioFrames(a)) {
      if (!a.deltaClamped) {
        if (frame.tfdt + a.delta! < 0n) a.delta = -frame.tfdt;
        a.deltaClamped = true;
      }
      if (!this.hasMoreSegments(a)) break;
      await this.groupAudioFrame(a, frame);
      a.offset = offset;
    }
  }

  /** The last segment(s) of a run that ended cleanly: the run is over, so
   *  whatever `a`'s file holds is final (mirrors {@link assembleTail} for
   *  the video). */
  private async assembleAudioTail(a: AudioRendition): Promise<void> {
    if (a.delta == null) return;
    await this.pumpAudioFrames(a);
    await this.flushAudioPending(a);
  }

  /** Write `a`'s accumulated frames as its current served segment, coalesced
   *  into one moof/trun; skipped when empty, then advance to the next. */
  private async flushAudioPending(a: AudioRendition): Promise<void> {
    if (a.pending.length > 0) {
      const out = path.join(a.dir, segName(a.served));
      if (!(await this.exists(out))) {
        const frames = a.pending;
        const built = buildFragment(
          a.trackId!,
          a.served + 1,
          frames[0].tfdt + a.delta!,
          frames.map((f) => f.sample),
          frames.map((f) => f.data),
        );
        await writeFileAtomic(out, built);
      }
    }
    a.pending = [];
    a.served++;
  }
}

/** A fragment file's top-level boxes: each `moof` read whole, the others (the
 *  media data) by their extent only. */
async function* topBoxes(
  fh: FileHandle,
): AsyncGenerator<{ start: number; size: number; moof: Buffer | null }> {
  const { size: end } = await fh.stat();
  const head = Buffer.alloc(16);
  for (let start = 0; start < end; ) {
    const { bytesRead } = await fh.read(head, 0, head.length, start);
    const header = readBoxHeader(head.subarray(0, bytesRead), 0, start, end);
    if (!header) throw new Error(`malformed box at byte ${start} of ${end}`);
    let moof: Buffer | null = null;
    if (header.type === 'moof') {
      moof = Buffer.alloc(header.size);
      await fh.read(moof, 0, header.size, start);
    }
    yield { start, size: header.size, moof };
    start += header.size;
  }
}

/** The `moof` boxes of a fragment file, back to back. */
async function readMoofs(file: string): Promise<Buffer> {
  const fh = await fsp.open(file, 'r');
  try {
    const moofs: Buffer[] = [];
    for await (const box of topBoxes(fh)) if (box.moof) moofs.push(box.moof);
    return Buffer.concat(moofs);
  } finally {
    await fh.close();
  }
}

async function copyRange(
  src: FileHandle,
  out: FileHandle,
  start: number,
  size: number,
  chunk: Buffer,
): Promise<void> {
  for (let done = 0; done < size; ) {
    const { bytesRead } = await src.read(chunk, 0, Math.min(chunk.length, size - done), start + done);
    if (bytesRead === 0) throw new Error(`fragment file ends ${size - done} bytes early`);
    await out.write(chunk, 0, bytesRead);
    done += bytesRead;
  }
}

// ── Audio fragment tailing (buildMultiAudioOutputs' `a<i>.mp4`) ───────────

/** One audio frame read from a track's growing file: its own moof (one
 *  sample per fragment, `frag_every_frame`) and its mdat's sample bytes. */
interface RawFrame {
  tfdt: bigint;
  sample: RawSample;
  data: Buffer;
}

/** Parse one (moof, mdat) fragment pair. */
function parseFrame(moof: Buffer, mdat: Buffer): RawFrame {
  const moofBody = moof.readUInt32BE(0) === 1 ? 16 : 8;
  const traf = findBox(moof, moofBody, moof.length, 'traf');
  const tfdt = traf && readTfdt(moof, traf);
  if (!traf || !tfdt) {
    throw new Error('audio fragment missing traf/tfhd/tfdt/trun');
  }
  const samples = trunSamples(moof, traf);
  if (samples.length !== 1) {
    throw new Error(`expected 1 sample per audio fragment (frag_every_frame), got ${samples.length}`);
  }
  const mdatBody = mdat.readUInt32BE(0) === 1 ? 16 : 8;
  return { tfdt: tfdt.value, sample: samples[0], data: mdat.subarray(mdatBody) };
}

const TFHD_BASE_IS_MOOF = 0x020000;

/** Fullbox header: version(1) + flags(3), as one big-endian word. */
function fullbox(version: number, flags: number): Buffer {
  return u32((version << 24) | flags);
}

/** One served audio segment: `samples` coalesced into a single moof/trun
 *  instead of one moof per source frame, cutting the box overhead a
 *  raw fragment-per-frame stream would otherwise carry into every segment. */
function buildFragment(
  trackId: number,
  sequenceNumber: number,
  tfdt: bigint,
  samples: RawSample[],
  data: Buffer[],
): Buffer {
  const useCts = samples.some((s) => s.cts != null);
  // Version 0's cts is unsigned by spec; a negative value only round-trips
  // through a reader if the box says version 1 (signed).
  const trunVersion = samples.some((s) => (s.cts ?? 0) < 0) ? 1 : 0;
  const mfhd = makeBox('mfhd', [fullbox(0, 0), u32(sequenceNumber)]);
  const tfhd = makeBox('tfhd', [fullbox(0, TFHD_BASE_IS_MOOF), u32(trackId)]);
  const tfdtValue = Buffer.alloc(8);
  tfdtValue.writeBigUInt64BE(tfdt, 0);
  const tfdtBuf = makeBox('tfdt', [fullbox(1, 0), tfdtValue]);
  const build = (dataOffset: number) => {
    const flags =
      TRUN_DATA_OFFSET |
      TRUN_SAMPLE_DURATION |
      TRUN_SAMPLE_SIZE |
      TRUN_SAMPLE_FLAGS |
      (useCts ? TRUN_SAMPLE_CTS : 0);
    const parts = [fullbox(trunVersion, flags), u32(samples.length), u32(dataOffset)];
    for (const s of samples) {
      parts.push(u32(s.duration), u32(s.size), u32(s.flags));
      if (useCts) parts.push(u32(s.cts ?? 0));
    }
    return makeBox('moof', [mfhd, makeBox('traf', [tfhd, tfdtBuf, makeBox('trun', parts)])]);
  };
  const moof = build(0);
  // `default_base_moof`: data_offset counts from this moof's own start, so
  // its value needs the moof's size, unchanged by the value written into it.
  return Buffer.concat([build(moof.length + 8), makeBox('mdat', data)]);
}

/** Complete top-level boxes past `from` in a file another process keeps
 *  appending to: readable once `start + size` fits the file's current size,
 *  a box mid-write is simply not there yet, picked up on the next poll. */
async function tailBoxes(
  file: string,
  from: number,
): Promise<{ type: string; start: number; size: number; buf: Buffer }[]> {
  const fh = await fsp.open(file, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const boxes: { type: string; start: number; size: number; buf: Buffer }[] = [];
    const head = Buffer.alloc(16);
    let start = from;
    for (;;) {
      if (start + 8 > fileSize) break;
      const { bytesRead } = await fh.read(head, 0, 16, start);
      // Size 0 ("to end of file") can't be told complete in a file still growing.
      if (bytesRead >= 4 && head.readUInt32BE(0) === 0) break;
      const header = readBoxHeader(head.subarray(0, bytesRead), 0, start, fileSize);
      if (!header) break;
      const buf = Buffer.alloc(header.size);
      await fh.read(buf, 0, header.size, start);
      boxes.push({ type: header.type, start, size: header.size, buf });
      start += header.size;
    }
    return boxes;
  } finally {
    await fh.close();
  }
}
