import { app, Menu } from 'electron';
import { DEFAULT_MENU_LABELS, menuTemplate, parseMenuLabels, type WindowCommands } from './menu-template';
import { readJson, writeJson } from './notify/prefs';
import type { DesktopMenuLabels } from '../shared/contract';

const LABELS_FILE = 'menu-labels.json';

// Read on first use: userData is only named right once index.ts has called setName.
let labels: DesktopMenuLabels | null = null;
let win: WindowCommands | null = null;

/** Rebuilds the macOS application menu from the current labels and window. */
export function refreshMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(app.getName(), (labels ??= parseMenuLabels(readJson(LABELS_FILE)) ?? DEFAULT_MENU_LABELS), win, !app.isPackaged)));
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
