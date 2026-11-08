import type { LyricsCue, LyricsWriteLine, StructuredLyrics } from '../../../core/services/api/lyrics.models';

export interface LyricsRow {
  start?: number;
  end?: number;
  text: string;
  agentId?: string;
  cues?: LyricsCue[];
}

/** One row per line; the enhanced cue lines replace the plain ones when present. */
export function toRows(doc: StructuredLyrics): LyricsRow[] {
  const byIndex = new Map((doc.cueLine ?? []).map((c) => [c.index, c]));
  return doc.line.map((l, i) => {
    const c = byIndex.get(i);
    return c
      ? { start: c.start, end: c.end, text: c.value, agentId: c.agentId, cues: c.cue }
      : { start: l.start, text: l.value };
  });
}

export interface CueSegment {
  text: string;
  /** Index of the cue this text is, or null for the text between cues. */
  cue: number | null;
  /** Index of the cue before this text, -1 for none. */
  prev: number;
}

/** A line cut at its cues' UTF-8 byte ranges: the cues and the text between them, so no word is glued to the next. */
export function cueSegments(text: string, cues: readonly LyricsCue[]): CueSegment[] {
  const bytes = new TextEncoder().encode(text);
  const slice = (a: number, b: number) => new TextDecoder().decode(bytes.slice(a, b));
  const out: CueSegment[] = [];
  let at = 0;
  cues.forEach((c, k) => {
    const from = Math.min(Math.max(c.byteStart, at), bytes.length);
    const to = Math.min(Math.max(c.byteEnd, from), bytes.length);
    if (from > at) out.push({ text: slice(at, from), cue: null, prev: k - 1 });
    out.push({ text: slice(from, to), cue: k, prev: k - 1 });
    at = to;
  });
  if (at < bytes.length) out.push({ text: slice(at, bytes.length), cue: null, prev: cues.length - 1 });
  return out;
}

/** The last line started at `posMs`; -1 before the first. A positive offset shows the text sooner. */
export function activeIndex(rows: readonly LyricsRow[], posMs: number, offsetMs: number): number {
  const t = posMs + offsetMs;
  let found = -1;
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i].start;
    if (s === undefined) return -1;
    if (s <= t) found = i;
    else break;
  }
  return found;
}

/** Fill 0..100 of each cue of a row at `posMs`. */
export function cueFills(cues: readonly LyricsCue[], posMs: number, offsetMs: number): number[] {
  const t = posMs + offsetMs;
  return cues.map((c) => (t <= c.start ? 0 : t >= c.end || c.end <= c.start ? 100 : ((t - c.start) / (c.end - c.start)) * 100));
}

/** A layer sits under the main lines only when it has one line per main line. */
export function layerAligned(main: StructuredLyrics, layer: StructuredLyrics): boolean {
  return main.line.length === layer.line.length;
}

export interface TapState {
  lines: { text: string; start?: number }[];
  next: number;
}

export function tapStart(text: string): TapState {
  return { lines: text.split(/\r?\n/).map((t) => ({ text: t.trim() })).filter((l) => l.text), next: 0 };
}

/** Stamps the next unstamped line; times never go back before the previous stamp. */
export function tapStamp(s: TapState, posMs: number): TapState {
  if (s.next >= s.lines.length) return s;
  const prev = s.next > 0 ? (s.lines[s.next - 1].start ?? 0) : 0;
  const lines = s.lines.map((l, i) => (i === s.next ? { ...l, start: Math.max(Math.round(posMs), prev) } : l));
  return { lines, next: s.next + 1 };
}

/** Un-stamps the last stamped line. */
export function tapBack(s: TapState): TapState {
  if (s.next === 0) return s;
  const next = s.next - 1;
  return { lines: s.lines.map((l, i) => (i === next ? { text: l.text } : l)), next };
}

/** The write body of a fully stamped session: each line ends where the next starts. */
export function tapLines(s: TapState): LyricsWriteLine[] | null {
  if (s.next < s.lines.length || !s.lines.length) return null;
  return s.lines.map((l, i) => ({ start: l.start, end: s.lines[i + 1]?.start, text: l.text }));
}
