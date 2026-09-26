import { execFile } from 'child_process';
import { promisify } from 'util';
import { Logger } from '@nestjs/common';
import { statSync } from 'fs';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import { sourceTimeline } from './source-timeline';

const execFileAsync = promisify(execFile);
const log = new Logger('SegmentBoundaries');

/**
 * Segment grid of the REMUX / copy-video path.
 *
 * Transcoded video forces an IDR every segment, so it sits on a uniform grid.
 * Copied video can only be cut at its own keyframes, which are irregular (1-15 s
 * on Blu-ray rips), so its playlist declares each segment's real length: strict
 * players (AVPlayer) trust EXTINF for the timeline and drift on a uniform one.
 *
 * ffmpeg cuts a remux run at every keyframe and the segments are assembled from
 * those GOPs on this grid (see `RemuxSegmentAssembler`), so the playlist and the
 * bytes of every segment are the same whichever run produced them. ffmpeg's own
 * cut targets count from the run's first packet, so a seeked run would cut
 * elsewhere than the playlist.
 */

/** How far under its first keyframe's decode time the run from the file start
 *  seeks: well under a frame, far above the microsecond a derived decode time
 *  can be off by. */
export const DECODE_TIME_TOLERANCE_SECONDS = 0.01;

/** A video keyframe packet, in source time. */
export interface Keyframe {
  pts: number;
  dts: number;
}

export interface SegmentGrid {
  /** Presented length of each segment (the playlist EXTINF). */
  durations: number[];
  /** Source time each segment's presentation starts at (the first one at the
   *  timeline origin), then the source end. */
  boundaries: number[];
  /** Video keyframes in decode order. */
  keyframes: Keyframe[];
  /** Index in `keyframes` of each segment's first keyframe, then their count. */
  firstKeyframe: number[];
}

interface CacheEntry {
  mtimeMs: number;
  segDur: number;
  grid: SegmentGrid;
}

const cache = new Map<string, CacheEntry>();

export interface VideoPackets {
  keyframes: Keyframe[];
  /** Source time the last frame ends at. */
  end: number;
}

/** Keyframe packets of the video stream, as the demuxer hands them to a copy
 *  (what the muxer cuts on), and where the video ends. Reads packets only,
 *  nothing is decoded. */
export async function extractVideoPackets(
  filePath: string,
  videoStreamIndex?: number,
): Promise<VideoPackets> {
  const select = videoStreamIndex != null ? String(videoStreamIndex) : 'v:0';
  const probe = (entries: string) =>
    execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', select, '-show_entries', entries, '-of', 'csv=p=0', filePath],
      { maxBuffer: 512 * 1024 * 1024, timeout: 300_000 },
    );
  const [stream, packets] = await Promise.all([
    probe('stream=has_b_frames,avg_frame_rate'),
    probe('packet=pts_time,dts_time,duration_time,flags'),
  ]);
  const [delay, rate] = stream.stdout.trim().split(',');
  return parseVideoPackets(packets.stdout, Number(delay) || 0, rate);
}

/**
 * `pts,dts,duration,flags` csv lines (decode order). Matroska stores no decode
 * times and the demuxer derives them only once reordering is known; ffmpeg's
 * copy starts the unknown ones `reorder / avg_frame_rate` under the first pts,
 * then adds the packet durations, and so does this.
 */
export function parseVideoPackets(
  csv: string,
  reorderFrames = 0,
  avgFrameRate = '0/0',
): VideoPackets {
  const packets = csv
    .split('\n')
    .map((line) => line.split(','))
    .filter((f) => f.length >= 4)
    .map(([p, d, dur, flags]) => ({
      pts: parseFloat(p),
      dts: parseFloat(d),
      dur: parseFloat(dur) || 0,
      key: flags.includes('K'),
    }))
    .filter((p) => Number.isFinite(p.pts));
  const [num, den] = avgFrameRate.split('/').map(Number);
  // ffmpeg truncates the reorder delay to whole microseconds.
  const lead = num > 0 && den > 0 ? Math.trunc((reorderFrames * 1e6 * den) / num) / 1e6 : 0;
  let next = packets.length ? packets[0].pts - lead : 0;
  for (const p of packets) {
    if (!Number.isFinite(p.dts)) p.dts = next;
    next = p.dts + p.dur;
  }
  return {
    keyframes: packets.filter((p) => p.key).map(({ pts, dts }) => ({ pts, dts })),
    end: packets.reduce((m, p) => Math.max(m, p.pts + p.dur), -Infinity),
  };
}

/** The MPEG-TS demuxer seeks to a byte position and decoding picks up at the
 *  next keyframe, so a seek lands up to a GOP after its target; the others
 *  land on the keyframe at or before it. Unknown formats are assumed to. */
export function seeksPastKeyframe(formatName: string | undefined): boolean {
  return formatName == null || formatName.split(',').includes('mpegts');
}

/** Longest GOP a keyframe is looked for behind a seek target. */
const MAX_GOP_SECONDS = 64;

/** The last video keyframe presented at or before `seconds` (source time),
 *  read from a widening window of packets ahead of it. */
export async function keyframeAtOrBefore(
  filePath: string,
  videoStreamIndex: number | undefined,
  seconds: number,
): Promise<Keyframe | null> {
  const select = videoStreamIndex != null ? String(videoStreamIndex) : 'v:0';
  for (let window = 4; window <= MAX_GOP_SECONDS; window *= 2) {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v', 'error', '-select_streams', select,
        '-read_intervals', `${seconds - window}%${seconds}`,
        '-show_entries', 'packet=pts_time,dts_time,duration_time,flags',
        '-of', 'csv=p=0', filePath,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
    );
    const before = parseVideoPackets(stdout).keyframes.filter((k) => k.pts <= seconds);
    if (before.length) return before[before.length - 1];
  }
  return null;
}

/**
 * Group the keyframes into segments of about `segDur`: a segment ends at the
 * first keyframe at or past a target that starts one `segDur` after the first
 * and advances by `segDur` per cut, so lengths average `segDur`. The tail runs
 * to `end`, the source time the file ends at; a keyframe too close to it to
 * hold a frame stays in the last segment.
 *
 * The grid starts on the first keyframe presented at or after `origin`. An
 * edit list that starts mid-GOP hides the pre-roll ahead of it: copied, those
 * frames would be decoded before the timeline start, which MSE drops along
 * with everything that references them, or shown by a player that places the
 * first sample at the playlist start. The frames between `origin` and that
 * keyframe can't be decoded without the pre-roll, so a copy starts later.
 */
export function computeSegmentGrid(
  allKeyframes: Keyframe[],
  origin: number,
  end: number,
  segDur: number,
): SegmentGrid | null {
  const keyframes = allKeyframes.filter((k) => k.pts >= origin - TAIL_EPSILON);
  if (keyframes.length === 0 || segDur <= 0) return null;
  const last = keyframes[keyframes.length - 1].pts;
  const total = Math.max(end, last);
  const start = Math.max(origin, keyframes[0].pts);
  const boundaries = [start];
  const firstKeyframe = [0];
  let target = start + segDur;
  keyframes.forEach((kf, i) => {
    if (i === 0 || kf.pts < target || total - kf.pts <= TAIL_EPSILON) return;
    boundaries.push(kf.pts);
    firstKeyframe.push(i);
    target += segDur;
  });
  boundaries.push(total);
  firstKeyframe.push(keyframes.length);
  const durations = boundaries.slice(1).map((b, i) => b - boundaries[i]);
  return { durations, boundaries, keyframes, firstKeyframe };
}

/** Shorter than any frame: a keyframe this close to the end starts no segment. */
const TAIL_EPSILON = 0.001;

/** Segment index whose `[start, end)` window contains content position
 *  `seconds` (from the first frame); the boundaries are source times, so the
 *  position is moved by the timeline `origin` first. */
export function secondsToSegmentIndex(
  boundaries: number[],
  seconds: number,
  origin: number,
): number {
  if (seconds <= 0 || boundaries.length < 2) return 0;
  const at = seconds + origin;
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (at < boundaries[i + 1]) return i;
  }
  return boundaries.length - 2;
}

/**
 * Resolve (and cache) the keyframe grid of a source, ending where its video
 * ends. Null when keyframes can't be read; the caller then falls back to the
 * uniform grid. Cached by path + mtime + segment length.
 */
export async function getRemuxSegmentGrid(
  filePath: string,
  segDur: number,
  streamInfo?: Pick<MediaFileInfo, 'video' | 'formatStartSeconds'> | null,
): Promise<SegmentGrid | null> {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.segDur === segDur) {
    return hit.grid;
  }
  try {
    const { keyframes, end } = await extractVideoPackets(
      filePath,
      streamInfo?.video?.[0]?.streamIndex,
    );
    const { origin } = sourceTimeline(streamInfo, filePath);
    const grid = computeSegmentGrid(keyframes, origin, end, segDur);
    if (!grid) {
      log.warn(`No video keyframe in ${filePath}; falling back to uniform grid`);
      return null;
    }
    cache.set(filePath, { mtimeMs, segDur, grid });
    return grid;
  } catch (err) {
    log.warn(
      `Keyframe probe failed for ${filePath}; falling back to uniform grid: ${(err as Error).message}`,
    );
    return null;
  }
}
