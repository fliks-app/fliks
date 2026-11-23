import { Notification, shell } from 'electron';
import type { DesktopNotifyStatus } from '../../shared/contract.ts';

// The bundle id of the Mac App Store build differs from the DMG's (electron-builder.yml `mas.appId`).
export const APP_ID = process.mas ? 'media.fliks.app' : 'media.fliks.desktop';

/** The native reads, from the platform's addon; each is absent elsewhere. */
export interface StatusAddon {
  /** Windows `ToastNotifier.Setting`: `enabled` or why toasts are off. */
  notifySetting?(aumid: string): string;
  /** macOS `UNAuthorizationStatus`: `allowed`, `denied` or `undetermined`. */
  notifyAuthorization?(): Promise<string>;
}

const WIN_BLOCKS = ['app', 'user', 'policy', 'manifest'];
/** A setting Windows did not name counts as allowed, like an unreadable one. */
export const fromWinSetting = (s: string): DesktopNotifyStatus => (WIN_BLOCKS.includes(s) ? 'blocked' : 'allowed');
/** macOS asks on the first notification, so an undetermined app is not blocked. */
export const fromMacAuthorization = (s: string): DesktopNotifyStatus => (s === 'denied' ? 'blocked' : 'allowed');

async function platformAddon(): Promise<StatusAddon | null> {
  if (process.platform === 'win32') return (await import('../smtc-win')).winAddon();
  if (process.platform === 'darwin') return (await import('../mpv/mac-addon')).loadMacAddon();
  return null;
}

const READ_TIMEOUT_MS = 2000;
/** A notification daemon that never answers must not leave the page waiting. */
function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), READ_TIMEOUT_MS).unref())]);
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
    if (platform === 'darwin' && a?.notifyAuthorization) return fromMacAuthorization(await withTimeout(a.notifyAuthorization(), 'undetermined'));
  } catch (e) {
    console.error('[notify] status', e);
  }
  return 'allowed';
}

/** macOS only: notifications already allowed. Unlike {@link notifyStatus}, an undetermined app is not. */
export async function macNotificationsAllowed(addon: () => Promise<StatusAddon | null> = platformAddon): Promise<boolean> {
  try {
    const a = await addon();
    return !!a?.notifyAuthorization && (await withTimeout(a.notifyAuthorization(), 'undetermined')) === 'allowed';
  } catch {
    return false;
  }
}

/** The OS page where the user gives notifications back; Linux has no common one. */
export async function openNotifySettings(platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') await shell.openExternal('ms-settings:notifications');
  else if (platform === 'darwin') await shell.openExternal(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${APP_ID}`);
}
