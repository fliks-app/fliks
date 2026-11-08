import type { StructuredLyrics } from './api/lyrics.models';
import { toRows } from '../../shared/audio-player/lyrics/lyrics-logic';

/** A message of the Fliks namespace stays under 64 KiB: the document is cut well below it. */
export const CAST_LYRICS_CHUNK = 40_000;

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
  const json = castLyricsJson(doc);
  const parts = Math.max(1, Math.ceil(json.length / CAST_LYRICS_CHUNK));
  return Array.from({ length: parts }, (_, part) => ({
    kind: 'lyrics' as const,
    itemId,
    seq,
    part,
    parts,
    data: json.slice(part * CAST_LYRICS_CHUNK, (part + 1) * CAST_LYRICS_CHUNK),
  }));
}
