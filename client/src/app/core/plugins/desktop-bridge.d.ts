import type { FliksDesktopApi, FliksDownloaderApi, FliksUpdaterApi } from '@fliks/desktop-contract';

// Ambient `Window` augmentation. Kept in a `.d.ts` (matched by every tsconfig's `src/**/*.d.ts` include) so the
// spec program sees it too: the bridge modules that read these aren't pulled into it.
declare global {
  interface Window {
    /** Injected by the Electron desktop preload; absent in browser / native. */
    fliksDesktop?: FliksDesktopApi;
    /** Offline-download bridge; injected by the Electron desktop preload. */
    fliksDownloader?: FliksDownloaderApi;
    /** Updater bridge; injected by the Electron desktop preload. */
    fliksUpdater?: FliksUpdaterApi;
  }
}
