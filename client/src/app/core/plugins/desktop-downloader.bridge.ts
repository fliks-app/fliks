import type { FliksDownloaderApi } from '@fliks/desktop-contract';

// Bridge to the Electron offline-download service on `window.fliksDownloader`; the types are desktop/src/shared/contract.ts's.
export type {
  DesktopDownloadItem,
  DesktopDownloadRequest,
  DesktopDownloadStatus,
  FliksDownloaderApi,
} from '@fliks/desktop-contract';

/** The desktop downloader bridge, or null when not running in the Electron shell. */
export function desktopDownloaderOrNull(): FliksDownloaderApi | null {
  return typeof window !== 'undefined' ? (window.fliksDownloader ?? null) : null;
}
