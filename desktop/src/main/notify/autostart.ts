import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { autostartEntry } from './desktop-entry';

const entryPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'fliks.desktop');

/** The command the login session runs: the AppImage when there is one, else this executable. */
function command(): string[] {
  const exe = process.env.APPIMAGE ?? process.execPath;
  return [exe, ...(app.isPackaged ? [] : [app.getAppPath()]), HIDDEN_ARG];
}

export const HIDDEN_ARG = '--hidden';

/** Applies the setting and returns what is really in effect afterwards (a silent failure reads back false). */
export function setStartAtLogin(on: boolean): boolean {
  try {
    if (process.platform === 'linux') {
      if (on) {
        fs.mkdirSync(path.dirname(entryPath()), { recursive: true });
        fs.writeFileSync(entryPath(), autostartEntry(command(), app.getName()));
      } else {
        fs.rmSync(entryPath(), { force: true });
      }
      return fs.existsSync(entryPath());
    }
    const args = process.platform === 'win32' ? [HIDDEN_ARG] : [];
    app.setLoginItemSettings({ openAtLogin: on, args });
    return app.getLoginItemSettings({ args }).openAtLogin;
  } catch (e) {
    console.error('[notify] start at login', e);
    return false;
  }
}

/** The OS started the app at login, in the session's own way. */
export function startedAtLogin(): boolean {
  return process.argv.includes(HIDDEN_ARG) || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}
