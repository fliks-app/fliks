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
  playPause: 'Play/Pause',
  stop: 'Stop',
  skipBack: 'Skip Back',
  skipForward: 'Skip Forward',
};

/** Keys the page's players already handle (the OS media widgets send the same ones). */
export type MediaKey = 'MediaPlayPause' | 'MediaStop' | 'MediaNextTrack' | 'MediaPreviousTrack';

/** Delivers a media key to the page as a key press; the page's own session decides what it does. */
export function pressMediaKey(contents: Electron.WebContents, keyCode: MediaKey): void {
  for (const type of ['keyDown', 'keyUp'] as const) contents.sendInputEvent({ type, keyCode });
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
  playback: ((key: MediaKey) => void) | null = null,
): MenuItemConstructorOptions[] {
  const fullScreen = win?.isFullscreen() ?? false;
  const key = (k: MediaKey): MenuItemConstructorOptions['click'] => () => playback?.(k);
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
      // No accelerators: Space and the arrows belong to the page. Previous/next skip, or change track in music.
      label: l.playback,
      submenu: [
        { label: l.playPause, enabled: playback !== null, click: key('MediaPlayPause') },
        { label: l.stop, enabled: playback !== null, click: key('MediaStop') },
        { type: 'separator' },
        { label: l.skipBack, enabled: playback !== null, click: key('MediaPreviousTrack') },
        { label: l.skipForward, enabled: playback !== null, click: key('MediaNextTrack') },
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
