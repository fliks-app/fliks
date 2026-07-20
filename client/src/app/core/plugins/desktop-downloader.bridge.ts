// Bridge to the Electron desktop shell's offline-download service, exposed on
// `window.fliksDownloader` by the desktop preload. Types mirror
// desktop/src/shared/contract.ts — the two live in separate build workspaces,
// so the shape is intentionally duplicated here.

export interface DesktopDownloadRequest {
  id: string;
  url: string;
  filename?: string;
  quality?: string;
}

export interface DesktopDownloadItem {
  id: string;
  filename: string;
  path: string;
  size: number;
  received: number;
  complete: boolean;
}

export type DesktopDownloadStatus =
  | { id: string; state: 'progress'; received: number; total: number }
  | { id: string; state: 'done'; item: DesktopDownloadItem }
  | { id: string; state: 'error'; message: string };

export interface FliksDownloaderApi {
  start(req: DesktopDownloadRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<DesktopDownloadItem[]>;
  getLocalUrl(id: string): Promise<string | null>;
  saveFile(key: string, url: string): Promise<boolean>;
  fileUrl(key: string): Promise<string | null>;
  deleteFile(key: string): Promise<void>;
  onStatus(handler: (status: DesktopDownloadStatus) => void): () => void;
}

declare global {
  interface Window {
    fliksDownloader?: FliksDownloaderApi;
  }
}

/** The desktop downloader bridge, or null when not running in the Electron shell. */
export function desktopDownloaderOrNull(): FliksDownloaderApi | null {
  return typeof window !== 'undefined' ? (window.fliksDownloader ?? null) : null;
}
