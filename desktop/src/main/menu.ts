import { app, Menu } from 'electron';
import { DEFAULT_MENU_LABELS, menuTemplate, parseMenuLabels, type MediaKey } from './menu-template';
import { readJson, writeJson } from './notify/prefs';
import type { DesktopMenuLabels } from '../shared/contract';

const LABELS_FILE = 'menu-labels.json';

// Read on first use: userData is only named right once index.ts has called setName.
let labels: DesktopMenuLabels | null = null;
let isFullscreen: () => boolean = () => false;
let playback: ((key: MediaKey) => void) | null = null;

/** Rebuilds the macOS application menu; Windows and Linux have none (a menu there becomes a menu bar). */
export function refreshMenu(): void {
  if (process.platform !== 'darwin') return;
  labels ??= parseMenuLabels(readJson(LABELS_FILE)) ?? DEFAULT_MENU_LABELS;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(app.getName(), labels, isFullscreen(), !app.isPackaged, playback)));
}

/** Where the Playback menu sends its media keys. */
export function setMenuPlayback(send: ((key: MediaKey) => void) | null): void {
  playback = send;
  refreshMenu();
}

/** Where the View menu reads whether the player window is in full screen. */
export function setMenuFullscreen(read: () => boolean): void {
  isFullscreen = read;
  refreshMenu();
}

/** The page's labels in its UI language, kept for the next launch's first paint. */
export function setMenuLabels(v: unknown): void {
  const next = parseMenuLabels(v);
  if (!next) throw new Error('invalid menu labels');
  labels = next;
  writeJson(LABELS_FILE, next);
  refreshMenu();
}
