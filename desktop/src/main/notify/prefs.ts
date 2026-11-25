import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DesktopNotifyLabels, DesktopNotifyPrefs } from '../../shared/contract.ts';

export const DEFAULT_PREFS: DesktopNotifyPrefs = { notifications: true, background: false, startAtLogin: false };

const file = (name: string) => path.join(app.getPath('userData'), name);

export function readJson<T>(name: string): Partial<T> {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as Partial<T>;
  } catch {
    return {};
  }
}

export function writeJson(name: string, value: unknown): void {
  const tmp = `${file(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file(name));
}

export function loadPrefs(): DesktopNotifyPrefs {
  const raw = readJson<DesktopNotifyPrefs>('notify-prefs.json');
  return {
    notifications: raw.notifications !== false,
    background: raw.background === true,
    startAtLogin: raw.startAtLogin === true,
    ...(process.platform === 'darwin' ? { quitOnClose: raw.quitOnClose === true } : {}),
  };
}

export const savePrefs = (p: DesktopNotifyPrefs): void => writeJson('notify-prefs.json', p);

/** The last labels the page sent, so the tray reads right before the page has loaded. */
export function loadLabels(): DesktopNotifyLabels | null {
  const raw = readJson<DesktopNotifyLabels>('notify-labels.json');
  return typeof raw.open === 'string' && typeof raw.quit === 'string' && typeof raw.notifications === 'string'
    ? { open: raw.open, quit: raw.quit, notifications: raw.notifications }
    : null;
}

export const saveLabels = (l: DesktopNotifyLabels): void => writeJson('notify-labels.json', l);
