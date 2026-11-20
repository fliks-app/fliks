import type { MenuItemConstructorOptions } from 'electron';
import { MENU_LABEL_KEYS, type DesktopMenuLabels } from '../shared/contract.ts';

export const DEFAULT_MENU_LABELS: DesktopMenuLabels = {
  about: 'About Fliks',
  services: 'Services',
  hide: 'Hide Fliks',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  quit: 'Quit Fliks',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select All',
  view: 'View',
  enterFullScreen: 'Enter Full Screen',
  exitFullScreen: 'Exit Full Screen',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  close: 'Close Window',
  bringAllToFront: 'Bring All to Front',
  playback: 'Playback',
  play: 'Play',
  pause: 'Pause',
  stop: 'Stop',
  skipBack: 'Back 10 Seconds',
  skipForward: 'Forward 10 Seconds',
  nextItem: 'Next',
  previousItem: 'Previous',
};

/** The player as the OS media widgets drive it: the same media keys and seek requests reach the page. */
export interface PlaybackCommands {
  /** null while nothing is loaded. */
  playing(): boolean | null;
  toggle(): void;
  stop(): void;
  skip(seconds: number): void;
  next(): void;
  previous(): void;
}

/** The framed window's commands: the key window is a frameless overlay, so the window roles would hit the wrong one. */
export interface WindowCommands {
  toggleFullscreen(): void;
  isFullscreen(): boolean;
  minimize(): void;
  zoom(): void;
  close(): void;
}

/** `v` rebuilt key by key, or null when any label is missing or too long. */
export function parseMenuLabels(v: unknown): DesktopMenuLabels | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Partial<DesktopMenuLabels> = {};
  for (const k of MENU_LABEL_KEYS) {
    const label = o[k];
    if (typeof label !== 'string' || label.length === 0 || label.length > 100) return null;
    out[k] = label;
  }
  return out as DesktopMenuLabels;
}

/** `dev` adds the reload and DevTools items an unpackaged run needs. */
export function menuTemplate(
  appName: string,
  l: DesktopMenuLabels,
  win: WindowCommands | null,
  dev: boolean,
  playback: PlaybackCommands | null = null,
): MenuItemConstructorOptions[] {
  const fullScreen = win?.isFullscreen() ?? false;
  const playing = playback?.playing() ?? null;
  const loaded = playing !== null;
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: l.about },
        { type: 'separator' },
        { role: 'services', label: l.services },
        { type: 'separator' },
        { role: 'hide', label: l.hide },
        { role: 'hideOthers', label: l.hideOthers },
        { role: 'unhide', label: l.showAll },
        { type: 'separator' },
        { role: 'quit', label: l.quit },
      ],
    },
    {
      label: l.edit,
      submenu: [
        { role: 'undo', label: l.undo },
        { role: 'redo', label: l.redo },
        { type: 'separator' },
        { role: 'cut', label: l.cut },
        { role: 'copy', label: l.copy },
        { role: 'paste', label: l.paste },
        { role: 'selectAll', label: l.selectAll },
      ],
    },
    {
      label: l.view,
      submenu: [
        {
          label: fullScreen ? l.exitFullScreen : l.enterFullScreen,
          accelerator: 'Ctrl+Command+F',
          enabled: win !== null,
          click: () => win?.toggleFullscreen(),
        },
        ...(dev ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      // No accelerators: Space and the arrows belong to the page (text fields, the player's own keys).
      label: l.playback,
      submenu: [
        { label: playing ? l.pause : l.play, enabled: loaded, click: () => playback?.toggle() },
        { label: l.stop, enabled: loaded, click: () => playback?.stop() },
        { type: 'separator' },
        { label: l.skipBack, enabled: loaded, click: () => playback?.skip(-10) },
        { label: l.skipForward, enabled: loaded, click: () => playback?.skip(10) },
        { type: 'separator' },
        { label: l.previousItem, enabled: loaded, click: () => playback?.previous() },
        { label: l.nextItem, enabled: loaded, click: () => playback?.next() },
      ],
    },
    {
      label: l.window,
      submenu: [
        { label: l.minimize, accelerator: 'Command+M', enabled: win !== null, click: () => win?.minimize() },
        { label: l.zoom, enabled: win !== null, click: () => win?.zoom() },
        { label: l.close, accelerator: 'Command+W', enabled: win !== null, click: () => win?.close() },
        { type: 'separator' },
        { role: 'front', label: l.bringAllToFront },
      ],
    },
  ];
}
