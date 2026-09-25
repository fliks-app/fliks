/** One subtitle cue: its timing line plus its (possibly multi-line) text. */
export interface SrtCue {
  /** Raw timing line, e.g. "00:00:01,000 --> 00:00:04,000". */
  timing: string;
  /** Cue text; may contain embedded newlines for multi-line cues. */
  text: string;
}

const TIMING_LINE = (l: string) => l.includes('-->');

/**
 * Parse an SRT document into text-bearing cues. Tolerant of a BOM, CRLF/CR line endings, blocks
 * with or without a leading index, and a cue separator that's missing or carries stray whitespace
 * (the next timing line always starts a new cue). Blocks without text or a timing line are dropped.
 */
export function parseSrt(content: string): SrtCue[] {
  const normalized = content
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const cues: SrtCue[] = [];
  for (const block of normalized.split(/\n[ \t]*\n/)) {
    const lines = block.split('\n');
    let start = lines.findIndex(TIMING_LINE);
    while (start !== -1) {
      const timing = lines[start].trim();
      const next = lines.findIndex((l, i) => i > start && TIMING_LINE(l));
      // A block missing its blank-line separator holds another cue; stop the
      // text there and drop the bare index line that introduces it, if any.
      const textEnd =
        next === -1
          ? lines.length
          : /^\d+$/.test(lines[next - 1]?.trim() ?? '')
            ? next - 1
            : next;
      const text = lines.slice(start + 1, textEnd).join('\n').trim();
      if (text) cues.push({ timing, text });
      start = next;
    }
  }
  return cues;
}

/** Serialize cues back into an SRT document, renumbering sequentially. */
export function serializeSrt(cues: SrtCue[]): string {
  return (
    cues.map((c, i) => `${i + 1}\n${c.timing}\n${c.text}`).join('\n\n') + '\n'
  );
}
