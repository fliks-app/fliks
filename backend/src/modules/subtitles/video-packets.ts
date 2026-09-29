import { createInterface } from 'readline';
import { stat } from 'fs/promises';
import * as path from 'path';
import type { Readable } from 'stream';
import { spawnBackground, collectStderrTail } from '../../common/utils/spawn-priority';

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
 *  row predating that field (source-timeline.ts already warns once per file). */
export function sourceIsMpegTs(
  si: { formatName?: string } | null | undefined,
  filePath: string,
): boolean {
  if (si?.formatName) return isMpegTs(si.formatName);
  return MPEG_TS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

/** Run ffprobe line by line; `onLine` returning false ends it early. With
 *  `input`, ffprobe reads it on stdin in place of the path in `args`. */
export function ffprobeLines(
  args: string[],
  onLine: (line: string) => boolean,
  opts: { timeoutMs: number; background?: boolean; input?: Readable },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawnBackground('ffprobe', args, { background: opts.background, io: true, cpu: true });
    const stderr = collectStderrTail(proc.stderr!, 2000);
    let stopped = false;
    const stop = () => {
      stopped = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`ffprobe timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    if (opts.input) {
      // A read ended early closes the pipe under the writer: EPIPE, not a failure.
      proc.stdin!.on('error', () => {});
      opts.input.on('error', (err) => {
        stop();
        reject(err);
      });
      opts.input.pipe(proc.stdin!);
    }
    createInterface({ input: proc.stdout! }).on('line', (line) => {
      if (!stopped && line && !onLine(line)) stop();
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (stopped || code === 0) resolve();
      else reject(new Error(`ffprobe exited ${code}: ${stderr.get().trim()}`));
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

/** Keyframes and end of the video, every packet read, none decoded. From
 *  `input` when given (the file's bytes), else from the file itself. */
export async function scanVideoPackets(
  filePath: string,
  video: VideoStreamRef,
  opts: { mpegTs: boolean; background?: boolean; input?: Readable },
): Promise<VideoPackets> {
  const { size } = await stat(filePath);
  const reader = new VideoPacketReader(await streamReorder(filePath, video), opts.mpegTs);
  await ffprobeLines(
    ['-v', 'error', '-select_streams', selectOf(video.streamIndex), '-show_entries',
      'packet=pts_time,dts_time,duration_time,flags', '-of', 'compact=p=0',
      opts.input ? 'pipe:0' : filePath],
    (line) => feedPacket(reader, line),
    {
      timeoutMs: Math.max(SCAN_MIN_TIMEOUT_MS, (size / SCAN_MIN_BYTES_PER_SECOND) * 1000),
      background: opts.background,
      input: opts.input,
    },
  );
  return reader.result();
}

/** Longest GOP a keyframe is looked for behind a seek target. */
const MAX_GOP_SECONDS = 64;
/** First window read behind a seek target: two DVB GOPs; doubling reaches
 *  x264's default 250-frame interval at 25 fps on the third read. */
const FIRST_WINDOW_SECONDS = 4;

/** The last video keyframe presented at or before `seconds` (source time):
 *  from the file's scanned keyframes, else from a widening window of packets ahead of it. */
export async function keyframeAtOrBefore(
  filePath: string,
  videoStreamIndex: number | undefined,
  seconds: number,
  scanned?: Keyframe[] | null,
): Promise<Keyframe | null> {
  const before = (keyframes: Keyframe[]) => {
    const found = keyframes.filter((k) => k.pts <= seconds);
    return found.length ? found[found.length - 1] : null;
  };
  if (scanned) return before(scanned);
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
