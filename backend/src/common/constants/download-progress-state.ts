/**
 * Closed vocabulary for a download's `state`, used by `download.progress` /
 * `acquisition.progress` and the `progress.set` plugin method. Core-owned so
 * an out-of-process plugin never has to speak a download client's own
 * vendor vocabulary — that mapping lives at the bundle boundary instead.
 */
export const DOWNLOAD_PROGRESS_STATES = [
  'queued',
  'active',
  'stalled',
  'paused',
  'importing',
] as const;

export type DownloadProgressState = (typeof DOWNLOAD_PROGRESS_STATES)[number];
