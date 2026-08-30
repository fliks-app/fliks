export type DownloadProgressState = 'queued' | 'active' | 'stalled' | 'paused' | 'importing';

/**
 * A leaf's phase as the UI sees it: the wire vocabulary plus `searching`, the
 * window between the user pressing grab and a download existing at all. Local to
 * the client — the backend never sends it, and never has to know about it.
 */
export type ProgressPhase = DownloadProgressState | 'searching';
