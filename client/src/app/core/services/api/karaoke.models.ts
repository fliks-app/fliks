export type KaraokeModelKind = 'separation' | 'alignment' | 'melody';
export type KaraokeModelState = 'absent' | 'downloading' | 'installed' | 'failed';
export type KaraokeStage = 'separate' | 'align' | 'melody';
export type KaraokeJobState = 'none' | 'queued' | 'running' | 'ready' | 'failed';
export type StemKind = 'vocals' | 'instrumental';

export interface KaraokeStatus {
  enabled: boolean;
  separate: boolean;
  align: boolean;
  melody: boolean;
  ready: boolean;
  gpu: boolean;
  background: boolean;
  /** Optimization workers that take separation jobs now. */
  workers: number;
  /** The engine can play a track in another key. */
  pitchShift: boolean;
}

export interface KaraokeLicence {
  name: string;
  text: string;
  clear: boolean;
}

export interface KaraokeModel {
  id: string;
  kind: KaraokeModelKind;
  name: string;
  version: string;
  licence: KaraokeLicence;
  default: boolean;
  /** Alignment only: the language codes it times, empty for every language. */
  languages: string[];
  /** Alignment only. */
  engine?: 'ctc' | 'whisper';
  /** The model card. */
  homepage: string;
  sizeBytes: number;
  diskBytes: number;
  installedVersion?: string;
  /** Installed with an older version than the catalogue's: still usable. */
  outdated: boolean;
  state: KaraokeModelState;
  downloadedBytes: number;
  /** While downloading. */
  bytesPerSecond?: number;
  /** Hashing the files of an installed model (`state` is `downloading`): nothing to cancel. */
  verifying: boolean;
  error?: string;
}

/** A directory of the models folder that no model names. */
export interface KaraokeOrphan {
  name: string;
  sizeBytes: number;
}

export interface KaraokeRuntime {
  onnx: boolean;
  onnxError?: string;
  providers: string[];
  whisper: boolean;
  rubberband: boolean;
  /** Windows 11 only: the engine runs the system Windows ML runtime, would after a restart, or lacks it. */
  windowsMl?: 'active' | 'restart' | 'missing';
}

export interface KaraokeModels {
  runtime: KaraokeRuntime;
  modelsDir: string;
  freeBytes?: number;
  usedBytes: number;
  orphans: KaraokeOrphan[];
  models: KaraokeModel[];
}

/** A language of the library and the model that times its lyrics (ids from `models`). */
export interface KaraokeLanguage {
  language: string;
  tracks: number;
  aligner: string | null;
  recommended: string | null;
}

/** Why a step failed: a stable `code` with its params; `message` only for settings managers. */
export interface KaraokeFailure {
  code: 'lyrics_not_found_in_vocals' | 'lyrics_too_long' | 'no_word_timed' | 'model_missing' | 'unsupported' | 'engine_unavailable' | 'cancelled' | 'failed';
  /** Percent of the lyrics found in the vocals, and the least that is kept. */
  matched?: number;
  min?: number;
  message?: string;
}

/** The last re-sync of a track; the server forgets it on restart. */
export interface KaraokeRealignResult {
  status: 'ok' | 'rejected' | 'failed' | 'skipped';
  /** Share of the lyrics found in the vocals, 0 to 1, when `rejected`. */
  matched: number | null;
  error: KaraokeFailure | null;
  at: number;
}

export interface KaraokeStaleTrack {
  itemId: number;
  title: string | null;
  album: string | null;
  artist: string | null;
  /** The outdated steps of the track. */
  stale: KaraokeStage[];
  /** Its outdated sync was rejected for the same lyrics by the current aligner. */
  refused: boolean;
  language: string | null;
  model: string | null;
  aligner: string | null;
  result: KaraokeRealignResult | null;
}

export interface KaraokeStaleCount {
  tracks: number;
  refused: number;
  stages: Record<KaraokeStage, number>;
  running: boolean;
  total: number;
  done: number;
}

export interface KaraokeStalePage {
  total: number;
  minMatch: number;
  items: KaraokeStaleTrack[];
}

export interface KaraokeItemState {
  state: KaraokeJobState;
  stage?: KaraokeStage;
  progress?: number;
  error?: KaraokeFailure;
  /** The `Align` or `Melody` failure of the last run that had one. */
  lyricsError?: KaraokeFailure;
  fileId: number;
  /** Both kinds present: the stems play, even while `align` or `melody` still run. */
  stems: Partial<Record<StemKind, { size: number; durationMs: number; contentType: string }>>;
  lyrics: boolean;
  melody: boolean;
  /** A `.cdg` file sits next to the track (MP3+G). */
  cdg: boolean;
}

/** Payload of the `karaoke.job_changed` SSE event. */
export interface KaraokeJobChanged {
  itemId: number;
  state: KaraokeJobState;
  stage?: KaraokeStage;
  progress?: number;
}
