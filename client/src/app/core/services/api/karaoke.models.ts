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
  files: { name: string; url: string; sha256: string; sizeBytes: number }[];
  state: KaraokeModelState;
  downloadedBytes: number;
  error?: string;
}

export interface KaraokeRuntime {
  onnx: boolean;
  onnxError?: string;
  providers: string[];
  whisper: boolean;
  rubberband: boolean;
}

export interface KaraokeModels {
  runtime: KaraokeRuntime;
  modelsDir: string;
  models: KaraokeModel[];
}

export interface KaraokeItemState {
  state: KaraokeJobState;
  stage?: KaraokeStage;
  progress?: number;
  error?: string;
  /** The `Align` or `Melody` failure of the last run; the stems are ready. */
  lyricsError?: string;
  fileId: number;
  stems: Partial<Record<StemKind, { size: number; durationMs: number }>>;
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

/** Total bytes of a model's files. */
export function karaokeModelSize(m: KaraokeModel): number {
  return m.files.reduce((n, f) => n + f.sizeBytes, 0);
}
