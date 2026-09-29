import { spawn } from 'child_process';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { PassThrough, type Readable } from 'stream';
import { Logger } from '@nestjs/common';
import type { MediaFileInfo } from '../../subtitles/ffprobe.service';
import {
  scanVideoPackets,
  sourceIsMpegTs,
  type Keyframe,
} from '../../subtitles/video-packets';

/** What one read of a whole source file tells playback; kept per file version. */
export interface SourceScan {
  /** Video keyframes in decode order. */
  keyframes: Keyframe[];
  /** Source time the last frame ends at, or where the clock breaks. */
  end: number;
  /** Source time an MPEG-TS clock breaks at. */
  breakSeconds?: number;
  /** By audio stream index: whether the AAC configuration changes mid-stream.
   *  Only MPEG-TS restates it per frame; elsewhere a track has one. */
  audioConfigChanges: Record<number, boolean>;
}

/** Whether a copied AAC track's profile, sample rate or channel configuration
 *  may change mid-stream: undefined until the file is scanned. */
export function aacConfigMayChange(
  scan: SourceScan | null | undefined,
  streamIndex: number,
): boolean | undefined {
  return scan ? (scan.audioConfigChanges[streamIndex] ?? false) : undefined;
}

const log = new Logger('SourceScan');

const ADTS_MIN_FRAME_BYTES = 7;
/** Past the latest first audio packet, how far the ADTS read probes. */
const ADTS_PROBE_MARGIN_SECONDS = 5;

/** Follows ADTS frames across chunks, noting a header whose configuration
 *  differs from the first one's. */
export class AdtsConfigWalker {
  changed = false;
  private config: number | undefined;
  private carry: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    const b = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    let i = 0;
    while (i + ADTS_MIN_FRAME_BYTES <= b.length) {
      // Syncword, then layer 0.
      if (b[i] !== 0xff || (b[i + 1] & 0xf6) !== 0xf0) {
        i++;
        continue;
      }
      const length = ((b[i + 3] & 0x03) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
      if (length < ADTS_MIN_FRAME_BYTES) {
        i++;
        continue;
      }
      if (i + length > b.length) break;
      // Profile and sampling index, the private bit masked; channel configuration.
      const config = ((b[i + 2] & 0xfd) << 8) | (b[i + 3] & 0xc0);
      if (this.config === undefined) this.config = config;
      else if (config !== this.config) this.changed = true;
      i += length;
    }
    this.carry = Buffer.from(b.subarray(i));
  }
}

/** The file's bytes, read once, at idle I/O priority for a background scan. */
function readSource(
  filePath: string,
  background: boolean,
): { stream: Readable; done: Promise<void>; stop: () => void } {
  if (background && process.platform === 'linux') {
    const cat = spawn('ionice', ['-c3', 'cat', '--', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stopped = false;
    let stderr = '';
    cat.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-500)));
    const done = new Promise<void>((resolve, reject) => {
      cat.on('error', reject);
      cat.on('close', (code) =>
        stopped || code === 0 ? resolve() : reject(new Error(`read failed (${code}): ${stderr.trim()}`)),
      );
    });
    return {
      stream: cat.stdout,
      done,
      stop: () => {
        stopped = true;
        cat.kill('SIGKILL');
      },
    };
  }
  const stream = createReadStream(filePath, { highWaterMark: 1 << 20 });
  const done = new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.on('close', resolve);
  });
  return { stream, done, stop: () => stream.destroy() };
}

/** Walks the ADTS headers of each AAC stream of an MPEG-TS read on `input`. A
 *  stream it could not read is reported as possibly changing. */
function walkAdts(
  input: Readable,
  streams: MediaFileInfo['audio'],
  formatStart: number,
  size: number,
  background: boolean,
): { result: Promise<Record<number, boolean>>; end: () => void } {
  // The demuxer needs each track's parameters before it writes one: probe past
  // the latest first packet, as the import's late-audio probe does.
  const reach = Math.max(...streams.map((a) => (a.startTimeSeconds ?? formatStart) - formatStart));
  const args = [
    '-v', 'error',
    '-analyzeduration', String(Math.ceil((Math.max(0, reach) + ADTS_PROBE_MARGIN_SECONDS) * 1e6)),
    '-probesize', String(size),
    '-f', 'mpegts', '-i', 'pipe:0',
  ];
  streams.forEach((a, i) =>
    args.push('-map', `0:${a.streamIndex}`, '-c', 'copy', '-f', 'data', `pipe:${3 + i}`),
  );
  const [cmd, cmdArgs] =
    background && process.platform === 'linux'
      ? ['nice', ['-n19', 'ffmpeg', ...args]]
      : ['ffmpeg', args];
  const proc = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'ignore', 'pipe', ...streams.map(() => 'pipe' as const)],
  });
  const walkers = streams.map((_, i) => {
    const walker = new AdtsConfigWalker();
    (proc.stdio[3 + i] as Readable).on('data', (d: Buffer) => walker.push(d));
    return walker;
  });
  let stderr = '';
  proc.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1000)));
  proc.stdin!.on('error', () => {});
  input.on('error', () => proc.kill('SIGKILL'));
  input.pipe(proc.stdin!);
  const result = new Promise<Record<number, boolean>>((resolve) => {
    const settle = (ok: boolean, why: string) => {
      const out: Record<number, boolean> = {};
      streams.forEach((a, i) => (out[a.streamIndex] = !ok || walkers[i].changed));
      if (!ok) log.warn(`AAC headers not read (${why}); their configuration may change`);
      resolve(out);
    };
    proc.on('error', (err) => settle(false, err.message));
    proc.on('close', (code) => settle(code === 0, `ffmpeg exited ${code}: ${stderr.trim()}`));
  });
  return {
    result,
    end: () => {
      input.unpipe(proc.stdin!);
      proc.stdin!.end();
    },
  };
}

/** Read the whole file once: its video packets, and on MPEG-TS the ADTS headers
 *  of its AAC tracks from the same bytes. */
export async function scanSource(
  filePath: string,
  si: Pick<MediaFileInfo, 'video' | 'audio' | 'formatName' | 'formatStartSeconds'>,
  opts: { background?: boolean } = {},
): Promise<SourceScan> {
  const v = si.video?.[0];
  if (!v) throw new Error('no video stream to scan');
  const video = { streamIndex: v.streamIndex, reorderFrames: v.reorderFrames, avgFrameRate: v.avgFrameRate };
  const background = !!opts.background;
  const mpegTs = sourceIsMpegTs(si, filePath);
  const aac = mpegTs ? (si.audio ?? []).filter((a) => a.codec === 'aac') : [];
  if (!aac.length) {
    const packets = await scanVideoPackets(filePath, video, { mpegTs, background });
    return { ...packets, audioConfigChanges: {} };
  }
  const { size } = await stat(filePath);
  const read = readSource(filePath, background);
  // Both readers take the bytes from the first one: a reader attached late
  // would miss the head of the file.
  const [forVideo, forAudio] = [new PassThrough(), new PassThrough()];
  read.stream.pipe(forVideo);
  read.stream.pipe(forAudio);
  read.stream.on('error', (err) => [forVideo, forAudio].forEach((b) => b.destroy(err)));
  const adts = walkAdts(forAudio, aac, si.formatStartSeconds ?? 0, size, background);
  // A tolerated early ffmpeg exit leaves forAudio unread; unpiping it here
  // stops its backpressure from stalling the shared read forVideo depends on.
  void adts.result.then(() => {
    read.stream.unpipe(forAudio);
    forAudio.resume();
  });
  try {
    const packets = await scanVideoPackets(filePath, video, { mpegTs, background, input: forVideo });
    // The video scan stops at a clock break; nothing after it is served.
    if (packets.breakSeconds !== undefined) read.stop();
    await read.done;
    adts.end();
    return { ...packets, audioConfigChanges: await adts.result };
  } catch (err) {
    read.stop();
    adts.end();
    await Promise.allSettled([read.done, adts.result]);
    throw err;
  }
}
