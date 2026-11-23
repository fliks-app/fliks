import type { FliksUpdaterApi } from '@fliks/desktop-contract';

// Bridge to the desktop shell's updater on `window.fliksUpdater`, consumed by AppUpdateService; the types are desktop/src/shared/contract.ts's.
export type {
  DesktopUpdateCapability,
  DesktopUpdateInfo,
  DesktopUpdateStatus,
  FliksUpdaterApi,
} from '@fliks/desktop-contract';

/** The desktop updater bridge, or null when not running in the Electron shell. */
export function desktopUpdaterOrNull(): FliksUpdaterApi | null {
  return typeof window !== 'undefined' ? (window.fliksUpdater ?? null) : null;
}
