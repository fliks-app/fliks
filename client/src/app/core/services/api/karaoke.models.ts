export type KaraokeModelKind = 'separation' | 'alignment' | 'melody';
export type KaraokeModelState = 'absent' | 'downloading' | 'installed' | 'failed';
export type KaraokeStage = 'separate' | 'align' | 'melody';
export type KaraokeJobState = 'none' | 'queued' | 'running' | 'ready' | 'failed';
export type StemKind = 'vocals' | 'instrumental' | 'guide';

export interface KaraokeStatus {
  enabled: boolean;
  separate: boolean;
  align: boolean;
  melody: boolean;
  ready: boolean;
  gpu: boolean;
  background: boolean;
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
  recommended: boolean;
  sizeBytes: number;
  diskBytes: number;
  installedVersion?: string;
  /** Installed with an older version than the catalogue's: still usable. */
  outdated: boolean;
  state: KaraokeModelState;
  downloadedBytes: number;
  /** While downloading. */
  bytesPerSecond?: number;
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

export interface KaraokeItemState {
  state: KaraokeJobState;
  stage?: KaraokeStage;
  progress?: number;
  error?: string;
  /** The `Align` or `Melody` failure of the last run; the stems are ready. */
  lyricsError?: string;
  fileId: number;
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
