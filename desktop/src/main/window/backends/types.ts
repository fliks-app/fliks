import type { BrowserWindow } from 'electron';

/**
 * Resolves how mpv embeds into / renders onto the video window for a given OS.
 * Linux (X11/XWayland) is the only backend wired today; macOS (child NSView),
 * Windows (child HWND) and a future Wayland-native backend slot in behind this
 * same interface without touching the player or the cross-platform layers.
 */
export interface EmbedBackend {
  readonly id: string;
  /** mpv output/embed args (e.g. `--wid`, `--vo`, `--hwdec`) and an optional
   *  environment override (e.g. forcing X11 over Wayland) for this window. */
  resolve(videoWin: BrowserWindow): { args: string[]; env?: NodeJS.ProcessEnv };
}
