import { Logger } from '@nestjs/common';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { PlayMethod } from '../dto/playback-info.dto';
import type { SourceTimeline } from '../transcoding/source-timeline';
import { EdlRange, parseEdl } from './edl-parser';

const log = new Logger('EdlSidecar');
const MAX_BYTES = 1024 * 1024;
const MAX_CACHED = 1000;
const MAX_LOGGED_REJECTS = 5;

const cache = new Map<string, { mtimeMs: number; size: number; ranges: EdlRange[] }>();
const warned = new Set<string>();

export function edlPathFor(absVideoPath: string): string {
  const { dir, name } = path.parse(absVideoPath);
  return path.join(dir, `${name}.edl`);
}

/** The sidecar path as it exists on disk (any letter case), or null. */
export async function resolveEdlPath(absVideoPath: string): Promise<string | null> {
  const exact = edlPathFor(absVideoPath);
  try {
    await fsp.lstat(exact);
    return exact;
  } catch {
    // fall through to the case-insensitive scan
  }
  try {
    const want = path.basename(exact).toLowerCase();
    const hit = (await fsp.readdir(path.dirname(exact))).find((n) => n.toLowerCase() === want);
    return hit ? path.join(path.dirname(exact), hit) : null;
  } catch {
    return null;
  }
}

/** Parsed sidecar ranges on the container timeline; null when absent or unusable. */
export async function readEdlSidecar(
  absVideoPath: string,
  fps?: number,
): Promise<EdlRange[] | null> {
  const edlPath = (await resolveEdlPath(absVideoPath)) ?? edlPathFor(absVideoPath);
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(edlPath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_BYTES) {
      warnOnce(`${edlPath}:${st.mtimeMs}:size`, `Ignoring ${edlPath}: ${st.size} bytes exceeds ${MAX_BYTES}`);
      return null;
    }
    // Frame-based lines resolve against the fps, so it is part of the key.
    const key = `${edlPath}|${fps ?? ''}`;
    const hit = cache.get(key);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.ranges;

    const buf = Buffer.alloc(Math.min(st.size, MAX_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const parsed = parseEdl(buf.toString('utf8', 0, bytesRead), fps);
    if (parsed.rejected.length) {
      const shown = parsed.rejected
        .slice(0, MAX_LOGGED_REJECTS)
        .map((r) => `line ${r.line}: ${r.reason}`)
        .join(', ');
      warnOnce(
        `${edlPath}:${st.mtimeMs}:rejects`,
        `${edlPath}: ${parsed.rejected.length} line(s) rejected (${shown})`,
      );
    }
    log.debug(`${edlPath}: ${parsed.ranges.length} range(s), ${parsed.sceneMarkers} scene marker(s) ignored`);
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, ranges: parsed.ranges });
    return parsed.ranges;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    warnOnce(`${edlPath}:err:${code}`, `Cannot read ${edlPath}: ${(err as Error).message}`);
    return null;
  } finally {
    await fh?.close();
  }
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  if (warned.size >= MAX_CACHED) warned.clear();
  warned.add(key);
  log.warn(message);
}

/** Container-time ranges moved onto the clock of the chosen play method. */
export function toPlaybackTimeline(
  ranges: EdlRange[],
  timeline: Pick<SourceTimeline, 'formatStart' | 'origin'>,
  playMethod: PlayMethod,
): EdlRange[] {
  const shift = playMethod === 'DirectPlay' ? 0 : timeline.formatStart - timeline.origin;
  const out: EdlRange[] = [];
  for (const r of ranges) {
    const end = Math.round((r.end + shift) * 1000) / 1000;
    const start = Math.round(Math.max(0, r.start + shift) * 1000) / 1000;
    if (end > start) out.push({ start, end, action: r.action });
  }
  return out;
}

/** Test hook: forget cached parses and logged warnings. */
export function resetEdlSidecarState(): void {
  cache.clear();
  warned.clear();
}
