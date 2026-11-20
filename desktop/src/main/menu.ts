import { app, Menu } from 'electron';
import { DEFAULT_MENU_LABELS, menuTemplate, parseMenuLabels, type PlaybackCommands, type WindowCommands } from './menu-template';
import { readJson, writeJson } from './notify/prefs';
import type { DesktopMenuLabels } from '../shared/contract';

const LABELS_FILE = 'menu-labels.json';

// Read on first use: userData is only named right once index.ts has called setName.
let labels: DesktopMenuLabels | null = null;
let win: WindowCommands | null = null;
let playback: PlaybackCommands | null = null;

/** Rebuilds the macOS application menu; Windows and Linux have none (a menu there becomes a menu bar). */
export function refreshMenu(): void {
  if (process.platform !== 'darwin') return;
  labels ??= parseMenuLabels(readJson(LABELS_FILE)) ?? DEFAULT_MENU_LABELS;
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(app.getName(), labels, win, !app.isPackaged, playback)));
}

/** The player the Playback menu drives; refreshed on each play/pause change. */
export function setMenuPlayback(commands: PlaybackCommands | null): void {
  playback = commands;
  refreshMenu();
}

/** The window the menu's window commands act on. */
export function setMenuWindow(commands: WindowCommands | null): void {
  win = commands;
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
