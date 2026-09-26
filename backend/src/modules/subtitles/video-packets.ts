import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { stat } from 'fs/promises';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { withFfmpegSlot } from '../../common/utils/ffmpeg-slots';

const log = new Logger('VideoPackets');

/** A video keyframe packet, in source time. */
export interface Keyframe {
  pts: number;
  dts: number;
}

export interface VideoPackets {
  keyframes: Keyframe[];
  /** Source time the last frame ends at, or where the clock breaks. */
  end: number;
  /** Source time an MPEG-TS clock breaks at (a concatenated or restarted
   *  recording): what follows is not on this timeline and is left out. */
  breakSeconds?: number;
}

/** What the scan needs to know of the video stream. */
export interface VideoStreamRef {
  streamIndex?: number;
  /** Reordered frames (`has_b_frames`); read from the file when absent. */
  reorderFrames?: number;
  /** `avg_frame_rate` as ffprobe gives it; read with `reorderFrames`. */
  avgFrameRate?: string;
}

const MPEG_TS_EXTENSIONS = new Set(['.ts', '.m2ts', '.mts', '.m2t', '.tp', '.trp']);

/** ffprobe's name for an MPEG-TS demux, whatever the file is called. */
export function isMpegTs(formatName: string | undefined): boolean {
  return formatName?.split(',').includes('mpegts') ?? false;
}

/** Whether a probed file is MPEG-TS: its format name, or the extension for a
 *  row probed before the format name was kept. */
export function sourceIsMpegTs(
  si: { formatName?: string } | null | undefined,
  filePath: string,
): boolean {
  if (si?.formatName) return isMpegTs(si.formatName);
  const byExtension = MPEG_TS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  log.debug(`${filePath}: no format name probed; MPEG-TS by extension: ${byExtension}`);
  return byExtension;
}

/** ffmpeg's backward discontinuity: a decode time 0.1 s behind the last one. */
const CLOCK_BACKWARD_SECONDS = 0.1;
/** Longer than a reception dropout, whose gap the clock keeps running over: a
 *  forward jump past it is a restarted clock. */
const MAX_DROPOUT_SECONDS = 300;

/** Packets in decode order, as a copy gets them: decode times Matroska leaves
 *  unknown start `reorder / avg_frame_rate` under the first pts, as ffmpeg's do. */
export class VideoPacketReader {
  private readonly keyframes: Keyframe[] = [];
  private end = -Infinity;
  private next: number | undefined;
  private last: { dts: number; dur: number } | undefined;
  private breakSeconds: number | undefined;

  constructor(
    private readonly leadSeconds: number,
    private readonly detectBreak: boolean,
  ) {}

  /** False once the clock broke: nothing after it belongs to the timeline. */
  add(pts: number, dts: number, dur: number, key: boolean): boolean {
    if (this.breakSeconds !== undefined) return false;
    // A packet the demuxer gives no time to has none a copy could cut on.
    if (!Number.isFinite(pts)) return true;
    const decode = Number.isFinite(dts) ? dts : (this.next ?? pts - this.leadSeconds);
    if (this.detectBreak && this.last) {
      const expected = this.last.dts + this.last.dur;
      if (decode < this.last.dts - CLOCK_BACKWARD_SECONDS || decode - expected > MAX_DROPOUT_SECONDS) {
        this.breakSeconds = this.end;
        return false;
      }
    }
    this.next = decode + dur;
    this.last = { dts: decode, dur };
    this.end = Math.max(this.end, pts + dur);
    if (key) this.keyframes.push({ pts, dts: decode });
    return true;
  }

  result(): VideoPackets {
    return {
      keyframes: this.keyframes,
      end: this.end,
      ...(this.breakSeconds === undefined ? {} : { breakSeconds: this.breakSeconds }),
    };
  }
}

/** ffprobe's `key=value|…` compact line as a map. */
function fields(line: string): Map<string, string> {
  return new Map(
    line.split('|').map((kv) => {
      const eq = kv.indexOf('=');
      return [kv.slice(0, eq), kv.slice(eq + 1)] as [string, string];
    }),
  );
}

const num = (v: string | undefined) => (v === undefined || v === 'N/A' ? NaN : parseFloat(v));

/** Feed one compact packet line; false to stop reading. */
function feedPacket(reader: VideoPacketReader, line: string): boolean {
  const f = fields(line);
  return reader.add(
    num(f.get('pts_time')),
    num(f.get('dts_time')),
    num(f.get('duration_time')) || 0,
    (f.get('flags') ?? '').includes('K'),
  );
}

/** Run ffprobe line by line; `onLine` returning false ends it early. */
export function ffprobeLines(
  args: string[],
  onLine: (line: string) => boolean,
  opts: { timeoutMs: number; background?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc =
      opts.background && process.platform === 'linux'
        ? spawn('ionice', ['-c3', 'nice', '-n19', 'ffprobe', ...args])
        : spawn('ffprobe', args);
    let stderr = '';
    let stopped = false;
    const timer = setTimeout(() => {
      stopped = true;
      proc.kill('SIGKILL');
      reject(new Error(`ffprobe timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!stopped && line && !onLine(line)) {
        stopped = true;
        proc.kill('SIGKILL');
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stopped || code === 0) resolve();
      else reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
    });
  });
}

const selectOf = (streamIndex: number | undefined) =>
  streamIndex != null ? String(streamIndex) : 'v:0';

/** The reorder lead ffmpeg starts Matroska's derived decode times with,
 *  truncated to whole microseconds as ffmpeg does. */
function leadSeconds(reorderFrames: number, avgFrameRate: string | undefined): number {
  const [n, d] = (avgFrameRate ?? '0/0').split('/').map(Number);
  return n > 0 && d > 0 ? Math.trunc((reorderFrames * 1e6 * d) / n) / 1e6 : 0;
}

async function streamReorder(filePath: string, video: VideoStreamRef): Promise<number> {
  if (video.reorderFrames != null && video.avgFrameRate) {
    return leadSeconds(video.reorderFrames, video.avgFrameRate);
  }
  let lead = 0;
  await ffprobeLines(
    ['-v', 'error', '-select_streams', selectOf(video.streamIndex), '-show_entries',
      'stream=has_b_frames,avg_frame_rate', '-of', 'compact=p=0', filePath],
    (line) => {
      const f = fields(line);
      lead = leadSeconds(Number(f.get('has_b_frames')) || 0, f.get('avg_frame_rate'));
      return false;
    },
    { timeoutMs: 30_000 },
  );
  return lead;
}

/** Slowest storage a whole-file scan still waits out. */
const SCAN_MIN_BYTES_PER_SECOND = 10 * 1024 * 1024;
const SCAN_MIN_TIMEOUT_MS = 300_000;

async function scan(
  filePath: string,
  size: number,
  video: VideoStreamRef,
  detectBreak: boolean,
  background: boolean,
): Promise<VideoPackets> {
  const reader = new VideoPacketReader(await streamReorder(filePath, video), detectBreak);
  await ffprobeLines(
    ['-v', 'error', '-select_streams', selectOf(video.streamIndex), '-show_entries',
      'packet=pts_time,dts_time,duration_time,flags', '-of', 'compact=p=0', filePath],
    (line) => feedPacket(reader, line),
    {
      timeoutMs: Math.max(SCAN_MIN_TIMEOUT_MS, (size / SCAN_MIN_BYTES_PER_SECOND) * 1000),
      background,
    },
  );
  return reader.result();
}

interface ScanEntry {
  mtimeMs: number;
  streamIndex?: number;
  packets: Promise<VideoPackets>;
}

const scans = new Map<string, ScanEntry>();
/** Files whose scan stays in memory; a scan is a few hundred KB. */
const MAX_SCANS = 64;

/** Keyframes and end of the video, every packet read (none decoded) once per file
 *  version, a failure included; a background read takes an ffmpeg slot, idle I/O. */
export async function videoPackets(
  filePath: string,
  video: VideoStreamRef,
  opts: { mpegTs: boolean; background?: boolean },
): Promise<VideoPackets> {
  const { mtimeMs, size } = await stat(filePath);
  const hit = scans.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.streamIndex === video.streamIndex) {
    return hit.packets;
  }
  const run = () => scan(filePath, size, video, opts.mpegTs, !!opts.background);
  const packets = opts.background ? withFfmpegSlot(run) : run();
  scans.delete(filePath);
  scans.set(filePath, { mtimeMs, streamIndex: video.streamIndex, packets });
  if (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value!);
  return packets;
}

/** A read of the packet table, if one is held for this file version. */
export async function heldVideoPackets(filePath: string): Promise<VideoPackets | null> {
  const hit = scans.get(filePath);
  if (!hit) return null;
  const { mtimeMs } = await stat(filePath).catch(() => ({ mtimeMs: NaN }));
  return hit.mtimeMs === mtimeMs ? hit.packets.catch(() => null) : null;
}

/** Longest GOP a keyframe is looked for behind a seek target. */
const MAX_GOP_SECONDS = 64;
/** First window read behind a seek target: two DVB GOPs; doubling reaches
 *  x264's default 250-frame interval at 25 fps on the third read. */
const FIRST_WINDOW_SECONDS = 4;

/** The last video keyframe presented at or before `seconds` (source time):
 *  from a held packet table, else from a widening window of packets ahead of it. */
export async function keyframeAtOrBefore(
  filePath: string,
  videoStreamIndex: number | undefined,
  seconds: number,
): Promise<Keyframe | null> {
  const before = (keyframes: Keyframe[]) => {
    const found = keyframes.filter((k) => k.pts <= seconds);
    return found.length ? found[found.length - 1] : null;
  };
  const held = await heldVideoPackets(filePath);
  if (held) return before(held.keyframes);
  for (let window = FIRST_WINDOW_SECONDS; window <= MAX_GOP_SECONDS; window *= 2) {
    // Only MPEG-TS seeks come here, and its packets carry their decode times.
    const reader = new VideoPacketReader(0, false);
    await ffprobeLines(
      ['-v', 'error', '-select_streams', selectOf(videoStreamIndex), '-read_intervals',
        `${seconds - window}%${seconds}`, '-show_entries', 'packet=pts_time,dts_time,duration_time,flags',
        '-of', 'compact=p=0', filePath],
      (line) => feedPacket(reader, line),
      { timeoutMs: 30_000 },
    );
    const found = before(reader.result().keyframes);
    if (found) return found;
  }
  return null;
}
