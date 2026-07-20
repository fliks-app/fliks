import type { FliksDesktopApi } from './desktop-player.bridge';
import type { FliksDownloaderApi } from './desktop-downloader.bridge';

// Ambient `Window.fliksDesktop` augmentation. Kept in a `.d.ts` (matched by
// every tsconfig's `src/**/*.d.ts` include) so the global type is visible to
// the spec project too — the bridge module that injects it isn't pulled into
// the spec program, so a sibling `declare global` there isn't seen by specs.
declare global {
  interface Window {
    /** Injected by the Electron desktop preload; absent in browser / native. */
    fliksDesktop?: FliksDesktopApi;
    /** Offline-download bridge; injected by the Electron desktop preload. */
    fliksDownloader?: FliksDownloaderApi;
  }
}
