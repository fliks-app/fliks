import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { DesktopNotifyPrefs } from '../../shared/contract';

export const DEFAULT_PREFS: DesktopNotifyPrefs = { notifications: false, background: false, startAtLogin: false };

const file = () => path.join(app.getPath('userData'), 'notify-prefs.json');

export function loadPrefs(): DesktopNotifyPrefs {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<DesktopNotifyPrefs>;
    return {
      notifications: raw.notifications === true,
      background: raw.background === true,
      startAtLogin: raw.startAtLogin === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: DesktopNotifyPrefs): void {
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, file());
}
