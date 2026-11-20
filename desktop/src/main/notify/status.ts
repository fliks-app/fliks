import { Notification, shell } from 'electron';
import type { DesktopNotifyStatus } from '../../shared/contract.ts';

export const APP_ID = 'media.fliks.desktop';

/** The native reads, from the platform's addon; each is absent elsewhere. */
export interface StatusAddon {
  /** Windows `ToastNotifier.Setting`: `enabled` or why toasts are off. */
  notifySetting?(aumid: string): string;
  /** macOS `UNAuthorizationStatus`: `allowed`, `denied` or `undetermined`. */
  notifyAuthorization?(): string;
}

export const fromWinSetting = (s: string): DesktopNotifyStatus => (s === 'enabled' ? 'allowed' : 'blocked');
/** macOS asks on the first notification, so an undetermined app is not blocked. */
export const fromMacAuthorization = (s: string): DesktopNotifyStatus => (s === 'denied' ? 'blocked' : 'allowed');

async function platformAddon(): Promise<StatusAddon | null> {
  if (process.platform === 'win32') return (await import('../smtc-win')).winAddon();
  if (process.platform === 'darwin') return (await import('../mpv/mac-mpv-player')).loadMacAddon();
  return null;
}

/** Whether the OS shows this app's notifications; an unreadable setting counts as allowed. */
export async function notifyStatus(
  addon: () => Promise<StatusAddon | null> = platformAddon,
  platform: NodeJS.Platform = process.platform,
): Promise<DesktopNotifyStatus> {
  if (!Notification.isSupported()) return 'unavailable';
  try {
    const a = await addon();
    if (platform === 'win32' && a?.notifySetting) return fromWinSetting(a.notifySetting(APP_ID));
    if (platform === 'darwin' && a?.notifyAuthorization) return fromMacAuthorization(a.notifyAuthorization());
  } catch (e) {
    console.error('[notify] status', e);
  }
  return 'allowed';
}

/** The OS page where the user gives notifications back; Linux has no common one. */
export async function openNotifySettings(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') await shell.openExternal('ms-settings:notifications');
  else if (platform === 'darwin') await shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${APP_ID}`);
}
