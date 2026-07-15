/** One subtitle cue: its timing line plus its (possibly multi-line) text. */
export interface SrtCue {
  /** Raw timing line, e.g. "00:00:01,000 --> 00:00:04,000". */
  timing: string;
  /** Cue text; may contain embedded newlines for multi-line cues. */
  text: string;
}

/**
 * Parse an SRT document into text-bearing cues. Tolerant of a BOM, CRLF/CR line
 * endings, and blocks with or without a leading index. Blocks without a timing
 * line or with empty text are dropped (they carry nothing to translate).
 */
export function parseSrt(content: string): SrtCue[] {
  const normalized = content
    .replace(/^﻿/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const cues: SrtCue[] = [];
  for (const block of normalized.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const timing = lines[timingIdx].trim();
    const text = lines
      .slice(timingIdx + 1)
      .join('\n')
      .trim();
    if (!text) continue;
    cues.push({ timing, text });
  }
  return cues;
}

/** Serialize cues back into an SRT document, renumbering sequentially. */
export function serializeSrt(cues: SrtCue[]): string {
  return (
    cues.map((c, i) => `${i + 1}\n${c.timing}\n${c.text}`).join('\n\n') + '\n'
  );
}
