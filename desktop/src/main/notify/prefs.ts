import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DesktopNotifyLabels, DesktopNotifyPrefs } from '../../shared/contract.ts';

export const DEFAULT_PREFS: DesktopNotifyPrefs = { notifications: true, background: false, startAtLogin: false };

const file = (name: string) => path.join(app.getPath('userData'), name);

function read<T>(name: string): Partial<T> {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as Partial<T>;
  } catch {
    return {};
  }
}

function write(name: string, value: unknown): void {
  const tmp = `${file(name)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file(name));
}

export function loadPrefs(): DesktopNotifyPrefs {
  const raw = read<DesktopNotifyPrefs>('notify-prefs.json');
  return {
    notifications: raw.notifications !== false,
    background: raw.background === true,
    startAtLogin: raw.startAtLogin === true,
  };
}

export const savePrefs = (p: DesktopNotifyPrefs): void => write('notify-prefs.json', p);

/** The last labels the page sent, so the tray reads right before the page has loaded. */
export function loadLabels(): DesktopNotifyLabels | null {
  const raw = read<DesktopNotifyLabels>('notify-labels.json');
  return typeof raw.open === 'string' && typeof raw.quit === 'string' && typeof raw.notifications === 'string'
    ? { open: raw.open, quit: raw.quit, notifications: raw.notifications }
    : null;
}

export const saveLabels = (l: DesktopNotifyLabels): void => write('notify-labels.json', l);
