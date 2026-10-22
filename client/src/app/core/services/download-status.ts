export const DOWNLOAD_STATUSES = ['preparing', 'queued', 'downloading', 'paused', 'waiting_wifi', 'ready', 'failed'] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

/** States the native side reports on a `downloadProgress` event. */
export type NativeDownloadState = 'queued' | 'downloading' | 'paused' | 'waiting_wifi';

const LEGACY: Record<string, DownloadStatus> = { transcoding: 'preparing', pending: 'preparing' };

/** Maps a persisted status onto the union; an unknown value reads as failed so the row stays visible and deletable. */
export function normalizeStatus(raw: unknown): DownloadStatus {
  if ((DOWNLOAD_STATUSES as readonly unknown[]).includes(raw)) return raw as DownloadStatus;
  return LEGACY[String(raw)] ?? 'failed';
}

/** In flight: the task still has work to do or is held. */
export const isActive = (s: DownloadStatus): boolean => s !== 'ready' && s !== 'failed';

export const isPausable = (s: DownloadStatus): boolean => s === 'preparing' || s === 'queued' || s === 'downloading';

/** Shows a progress bar (as opposed to held or finished). */
export const isTransferring = (s: DownloadStatus): boolean => s === 'preparing' || s === 'downloading';

/** The held state a native event names, or null while it is transferring. */
export function heldStatus(state?: string): DownloadStatus | null {
  return state === 'queued' || state === 'paused' || state === 'waiting_wifi' ? state : null;
}

/** Toast key for a batch that started nothing: all targets already on the device, or nothing new. */
export function nothingStartedKey(skipped: number, total: number): string {
  return skipped > 0 && skipped === total ? 'downloads.already_downloaded' : 'downloads.nothing_new';
}
