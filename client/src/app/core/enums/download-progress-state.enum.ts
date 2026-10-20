export type DownloadProgressState = 'queued' | 'active' | 'stalled' | 'paused' | 'importing';

/** A leaf's UI phase: the wire vocabulary plus client-only `searching` (between pressing grab and a download existing). */
export type ProgressPhase = DownloadProgressState | 'searching';
