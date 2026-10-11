export type EdlAction = 'cut' | 'mute' | 'commercial';
export interface EdlRange {
  start: number;
  end: number;
  action: EdlAction;
}
export interface EdlParseResult {
  /** Sorted by start. */
  ranges: EdlRange[];
  rejected: { line: number; reason: string }[];
  sceneMarkers: number;
}

export const MAX_EDL_RANGES = 10000;

const ACTIONS: Record<string, EdlAction | 'scene'> = {
  '0': 'cut',
  '1': 'mute',
  '2': 'scene',
  '3': 'commercial',
};

const CLOCK = /^(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/;
const PLAIN = /^(?:\d+\.?\d*|\.\d+)$/;

/** Seconds rounded to the millisecond, or null when the token is not a time. */
function parseTime(token: string, fps?: number): number | null | 'nofps' {
  let seconds: number;
  if (token.includes(':')) {
    const m = CLOCK.exec(token);
    if (!m) return null;
    const ms = Number((m[4] ?? '').padEnd(3, '0').slice(0, 3));
    seconds = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000;
  } else if (token.startsWith('#')) {
    if (!/^#\d+$/.test(token)) return null;
    if (!fps || fps <= 0) return 'nofps';
    seconds = Number(token.slice(1)) / fps;
  } else if (PLAIN.test(token)) {
    seconds = Number(token);
  } else {
    return null;
  }
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null;
}

/** Kodi-compatible EDL text (MPlayer format is a subset). */
export function parseEdl(text: string, fps?: number): EdlParseResult {
  const ranges: EdlRange[] = [];
  const rejected: EdlParseResult['rejected'] = [];
  let sceneMarkers = 0;
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('##')) continue;
    const reject = (reason: string) => rejected.push({ line, reason });

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) {
      reject('fields');
      continue;
    }
    const actionToken = tokens.length === 2 ? tokens[1] : tokens[2];
    const leadingInt = /^\d+/.exec(actionToken)?.[0];
    const action = leadingInt === undefined ? undefined : ACTIONS[String(Number(leadingInt))];
    if (!action) {
      reject('action');
      continue;
    }
    if (tokens.length === 2) {
      if (action !== 'scene') {
        reject('fields');
        continue;
      }
      const t = parseTime(tokens[0], fps);
      if (t === null || t === 'nofps') reject(t === null ? 'time' : 'fps');
      else sceneMarkers++;
      continue;
    }

    const start = parseTime(tokens[0], fps);
    const end = parseTime(tokens[1], fps);
    if (start === null || end === null) {
      reject('time');
      continue;
    }
    if (start === 'nofps' || end === 'nofps') {
      reject('fps');
      continue;
    }
    if (action === 'scene') {
      sceneMarkers++;
      continue;
    }
    if (start >= end) {
      reject('order');
      continue;
    }
    if (ranges.length >= MAX_EDL_RANGES) {
      reject('limit');
      continue;
    }
    // ranges stay sorted and disjoint, so only the two neighbours can overlap.
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid].start < start) lo = mid + 1;
      else hi = mid;
    }
    if ((lo > 0 && ranges[lo - 1].end > start) || (lo < ranges.length && ranges[lo].start < end)) {
      reject('overlap');
      continue;
    }
    ranges.splice(lo, 0, { start, end, action });
  }

  return { ranges, rejected, sceneMarkers };
}
