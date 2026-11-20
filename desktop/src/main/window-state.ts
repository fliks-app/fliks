import { screen, type BrowserWindow } from 'electron';
import { readJson, writeJson } from './notify/prefs';
import { fitToDisplays, parseWindowState, type WindowState } from './window-state-fit';

const FILE = 'window-state.json';
const SAVE_DELAY_MS = 500;

/** The last saved window, or null when none exists or no display shows enough of its bounds. */
export function loadWindowState(): WindowState | null {
  const saved = parseWindowState(readJson(FILE));
  return saved && fitToDisplays(saved, screen.getAllDisplays().map((d) => d.workArea)) ? saved : null;
}

/** Saves the window's bounds, maximized and full-screen state as they change. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const save = () => {
    clearTimeout(timer);
    if (win.isDestroyed()) return;
    const { x, y, width, height } = win.getNormalBounds();
    const state: WindowState = { x, y, width, height, maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    try {
      writeJson(FILE, state);
    } catch (e) {
      console.error('[window] state not saved', e);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'resize', later);
  win.on('close', save);
}
