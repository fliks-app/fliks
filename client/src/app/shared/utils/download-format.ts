/** Shared download-progress formatting + qBittorrent state mapping, used by the
 *  Activity queue, the request rows, and media-detail so the numbers and the
 *  progress-bar colour are rendered identically everywhere. */

export type ProgressVariant =
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral';

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Map a raw qBittorrent torrent state to a progress-bar colour variant. */
export function qbStateVariant(state: string): ProgressVariant {
  switch (state) {
    case 'downloading':
    case 'forcedDL':
    case 'metaDL':
    case 'forcedMetaDL':
    case 'allocating':
      return 'primary';
    case 'uploading':
    case 'stalledUP':
    case 'forcedUP':
    case 'queuedUP':
    case 'checkingUP':
      return 'success';
    case 'stalledDL':
    case 'queuedDL':
    case 'checkingDL':
    case 'checkingResumeData':
    case 'moving':
      return 'warning';
    case 'error':
    case 'missingFiles':
      return 'error';
    case 'pausedDL':
    case 'pausedUP':
    case 'stoppedDL':
    case 'stoppedUP':
      return 'neutral';
    default:
      return 'primary';
  }
}
