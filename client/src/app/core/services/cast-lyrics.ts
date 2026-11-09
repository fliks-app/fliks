import type { StructuredLyrics } from './api/lyrics.models';
import { toRows } from '../../shared/audio-player/lyrics/lyrics-logic';

/** A message of the Fliks namespace stays under 64 KiB: a part's JSON-escaped data is cut to this many UTF-8 bytes, well below it. */
export const CAST_LYRICS_CHUNK = 60_000;

const encoder = new TextEncoder();

/** UTF-8 bytes of `ch` once embedded in a JSON string. */
function escapedBytes(ch: string): number {
  return encoder.encode(JSON.stringify(ch)).length - 2;
}

/** Slices `text` by code point so each slice's escaped UTF-8 size stays within `max`. */
export function sliceByBytes(text: string, max: number): string[] {
  const out: string[] = [];
  let from = 0;
  let size = 0;
  let at = 0;
  for (const ch of text) {
    const n = escapedBytes(ch);
    if (size + n > max) {
      out.push(text.slice(from, at));
      from = at;
      size = 0;
    }
    size += n;
    at += ch.length;
  }
  out.push(text.slice(from));
  return out;
}

export interface CastLyricsMessage {
  kind: 'lyrics';
  itemId: number;
  seq: number;
  part: number;
  parts: number;
  data: string;
}

/** The document the receiver draws: rows with word byte ranges, no pitch. */
export function castLyricsJson(doc: StructuredLyrics): string {
  const rows = toRows(doc).map((r) => ({
    start: r.start,
    end: r.end,
    text: r.text,
    ...(r.cues?.length ? { cues: r.cues.map((c) => ({ start: c.start, end: c.end, byteStart: c.byteStart, byteEnd: c.byteEnd })) } : {}),
  }));
  return JSON.stringify({ rows, offset: doc.offset, synced: doc.synced });
}

/** The document as `lyrics` messages; the receiver joins the parts of one `seq`. */
export function chunkLyrics(doc: StructuredLyrics, itemId: number, seq: number): CastLyricsMessage[] {
  const slices = sliceByBytes(castLyricsJson(doc), CAST_LYRICS_CHUNK);
  return slices.map((data, part) => ({ kind: 'lyrics' as const, itemId, seq, part, parts: slices.length, data }));
}
