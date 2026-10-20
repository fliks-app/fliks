// Bridge to the desktop shell's updater on `window.fliksUpdater`, consumed by AppUpdateService.
// Types mirror desktop/src/shared/contract.ts (separate build workspaces).

export interface DesktopUpdateInfo {
  version: string;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  releaseUrl: string | null;
}

export type DesktopUpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: DesktopUpdateInfo }
  | { state: 'not-available' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; info: DesktopUpdateInfo }
  | { state: 'error'; message: string };

export interface DesktopUpdateCapability {
  canInstall: boolean;
  currentVersion: string;
  releasesUrl: string;
}

export interface FliksUpdaterApi {
  getCapability(): Promise<DesktopUpdateCapability>;
  check(): Promise<void>;
  install(): Promise<void>;
  openReleases(): Promise<void>;
  onStatus(handler: (status: DesktopUpdateStatus) => void): () => void;
}

declare global {
  interface Window {
    fliksUpdater?: FliksUpdaterApi;
  }
}

/** The desktop updater bridge, or null when not running in the Electron shell. */
export function desktopUpdaterOrNull(): FliksUpdaterApi | null {
  return typeof window !== 'undefined' ? (window.fliksUpdater ?? null) : null;
}
