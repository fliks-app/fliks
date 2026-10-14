import { Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const log = new Logger('MkvLanguageTags');
const MKVMERGE_TIMEOUT_MS = 15_000;

export interface MkvLanguageTag {
  type: 'audio' | 'subtitle';
  tag: string;
}

/** The native bundles ship no mkvtoolnix; remember its absence for the process. */
let mkvmergeMissing = false;

const TRACK_TYPE = { audio: 'audio', subtitles: 'subtitle' } as const;
/** A language with at least one region, script or variant subtag. */
const QUALIFIED_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})+$/i;

/** Track id (= ffprobe stream index) → BCP-47 tag, for audio and subtitle tracks
 *  whose `language_ietf` says more than the bare language. Empty when unparsable. */
export function parseMkvLanguageTags(
  json: string,
): Map<number, MkvLanguageTag> {
  const out = new Map<number, MkvLanguageTag>();
  let tracks: unknown;
  try {
    tracks = (JSON.parse(json) as { tracks?: unknown }).tracks;
  } catch {
    return out;
  }
  if (!Array.isArray(tracks)) return out;
  for (const t of tracks as {
    id?: unknown;
    type?: unknown;
    properties?: { language_ietf?: unknown };
  }[]) {
    const type = TRACK_TYPE[t?.type as keyof typeof TRACK_TYPE];
    const tag = t?.properties?.language_ietf;
    if (
      !type ||
      typeof t.id !== 'number' ||
      typeof tag !== 'string' ||
      !QUALIFIED_TAG.test(tag) ||
      /^und-/i.test(tag)
    ) {
      continue;
    }
    out.set(t.id, { type, tag });
  }
  return out;
}

/** Sets `languageTag` on the streams whose mkvmerge track has the same id and type. */
export function applyMkvLanguageTags(
  tags: Map<number, MkvLanguageTag>,
  audio: { streamIndex: number; languageTag?: string }[],
  subtitles: { streamIndex: number; languageTag?: string }[],
): void {
  for (const [list, type] of [
    [audio, 'audio'],
    [subtitles, 'subtitle'],
  ] as const) {
    for (const s of list) {
      const t = tags.get(s.streamIndex);
      if (t?.type === type) s.languageTag = t.tag;
    }
  }
}

/** Runs `mkvmerge -J` on a Matroska file. Never throws: any failure (no binary,
 *  timeout, bad output) yields no tags. */
export async function readMkvLanguageTags(
  videoPath: string,
): Promise<Map<number, MkvLanguageTag>> {
  if (mkvmergeMissing) return new Map();
  try {
    const { stdout } = await execFileAsync('mkvmerge', ['-J', videoPath], {
      timeout: MKVMERGE_TIMEOUT_MS,
      maxBuffer: 1 << 24,
    });
    return parseMkvLanguageTags(stdout);
  } catch (err: unknown) {
    const e = err as {
      code?: unknown;
      killed?: boolean;
      stdout?: unknown;
      message?: string;
    };
    if (e.code === 'ENOENT') {
      mkvmergeMissing = true;
      log.log('mkvmerge not found; BCP-47 language tags disabled');
      return new Map();
    }
    // mkvmerge exits 1 on warnings but still prints the full JSON.
    if (typeof e.stdout === 'string' && e.stdout) {
      const tags = parseMkvLanguageTags(e.stdout);
      if (tags.size) return tags;
    }
    log.warn(
      `mkvmerge -J failed for "${videoPath}": ${e.killed ? 'timed out' : (e.message ?? '').split('\n')[0]}`,
    );
    return new Map();
  }
}

/** Test seam: forget a cached missing binary. */
export function resetMkvmergeAvailability(): void {
  mkvmergeMissing = false;
}
