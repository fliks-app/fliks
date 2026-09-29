import type { BrowserWindow } from 'electron';

/** The HWND's low dword (win64 pads the high dword with sign-extension; mpv's
 *  --wid rejects a negative int). Shared by the real embed and its probe. */
export function readWindowHandle(win: BrowserWindow): number {
  return win.getNativeWindowHandle().readUInt32LE(0);
}

/**
 * Resolves how mpv embeds into / renders onto the video window for a given OS.
 * Windows (child HWND) is the only subprocess-embed backend wired today; macOS
 * embeds in-process libmpv instead and never routes through this interface.
 */
export interface EmbedBackend {
  readonly id: string;
  /** mpv output/embed args (e.g. `--wid`, `--vo`, `--hwdec`) and an optional
   *  environment override; `mpvPath` lets the gpu-next probe use the playback build. */
  resolve(
    videoWin: BrowserWindow,
    mpvPath: string,
  ): Promise<{ args: string[]; env?: NodeJS.ProcessEnv }>;
}
