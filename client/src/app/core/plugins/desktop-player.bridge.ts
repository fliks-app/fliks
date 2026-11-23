import type { FliksDesktopApi } from '@fliks/desktop-contract';

// Bridge to the Electron shell's embedded mpv player on `window.fliksDesktop`, consumed by DesktopEngine like NativePlayer.
// The types are desktop/src/shared/contract.ts's, the single definition shared with the shell.
export type {
  DesktopAudioTrack,
  DesktopEvent,
  DesktopLoadOptions,
  DesktopMediaMetadata,
  DesktopMuteRange,
  DesktopNotification,
  DesktopNotificationAction,
  DesktopNotificationClick,
  DesktopNotifyLabels,
  DesktopNotifyPrefs,
  DesktopNotifyStatus,
  DesktopPlayerCapabilities,
  DesktopPlayerState,
  DesktopPositionInfo,
  DesktopQoe,
  DesktopSubtitleStyle,
  DesktopSubtitleTrack,
  DesktopSystemInfo,
  FliksDesktopApi,
} from '@fliks/desktop-contract';

/** The desktop bridge, or null when not running in the Electron shell. */
export function desktopBridgeOrNull(): FliksDesktopApi | null {
  return typeof window !== 'undefined' ? (window.fliksDesktop ?? null) : null;
}

/** The desktop bridge; throws when not running in the Electron shell. */
export function desktopBridge(): FliksDesktopApi {
  const api = desktopBridgeOrNull();
  if (!api) throw new Error('fliksDesktop bridge unavailable (not in Electron shell)');
  return api;
}
