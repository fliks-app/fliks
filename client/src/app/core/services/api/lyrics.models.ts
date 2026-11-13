export type LyricsKind = 'main' | 'translation' | 'pronunciation';
export type LyricsFormat = 'lrc' | 'elrc' | 'ttml' | 'srt' | 'plain';

export interface LyricsLine {
  start?: number;
  value: string;
}

export interface LyricsAgent {
  id: string;
  role: 'main' | 'voice' | 'bg' | 'group';
  name?: string;
}

export interface LyricsNote {
  start: number;
  end: number;
  pitch: number;
}

export interface LyricsCue {
  start: number;
  end: number;
  value: string;
  byteStart: number;
  byteEnd: number;
  /** Main MIDI note of the reference melody; absent when unvoiced or unknown. */
  pitch?: number;
  /** Every note sung on the cue; absent means `pitch` over the whole cue. */
  notes?: LyricsNote[];
  golden?: boolean;
}

export interface LyricsCueLine {
  index: number;
  agentId?: string;
  start: number;
  end: number;
  value: string;
  cue: LyricsCue[];
}

/** Times are milliseconds; a positive `offset` shows the text sooner. */
export interface StructuredLyrics {
  id: number;
  kind: LyricsKind;
  lang: string;
  synced: boolean;
  offset: number;
  displayArtist: string;
  displayTitle: string;
  source: string;
  /** A provider source's display name. */
  sourceLabel?: string;
  sourceRef?: string;
  reviewed: boolean;
  preferred: boolean;
  line: LyricsLine[];
  agents?: LyricsAgent[];
  cueLine?: LyricsCueLine[];
}

export interface LyricsResponse {
  structuredLyrics: StructuredLyrics[];
  instrumental?: boolean;
}

export interface LyricsWriteLine {
  start?: number;
  end?: number;
  text: string;
}

export type LyricsWrite = { kind?: LyricsKind; lang?: string; offsetMs?: number } & (
  | { format: LyricsFormat; body: string }
  | { lines: LyricsWriteLine[] }
);
