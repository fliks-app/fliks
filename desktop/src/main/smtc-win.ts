import { app } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { NowPlayingAddon } from './now-playing';

interface SmtcNative extends NowPlayingAddon {
  attach(hwnd: Buffer): void;
}

/** The Windows System Media Transport Controls addon, bound to `hwnd` (the framed window). It is
 *  asarUnpack'd, so a packaged app has it under app.asar.unpacked. */
export function loadSmtcAddon(hwnd: Buffer): NowPlayingAddon {
  const base = app.isPackaged ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') : app.getAppPath();
  const addon = createRequire(__filename)(path.join(base, 'native', 'build', 'Release', 'fliks_smtc_win.node')) as SmtcNative;
  addon.attach(hwnd);
  // A WinRT failure must not escape the player's event handlers.
  const safe =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch (e) {
        console.error('[smtc]', e);
      }
    };
  return {
    setNowPlaying: safe((i) => addon.setNowPlaying(i)),
    clearNowPlaying: safe(() => addon.clearNowPlaying()),
    onRemoteCommand: (cb) => addon.onRemoteCommand(cb),
  };
}
