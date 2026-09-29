import type { BrowserWindow } from 'electron';
import type { EmbedBackend } from './types';
import { readWindowHandle } from './types';

/**
 * Windows embedding via mpv's `--wid` (reparents its video output as a child of
 * the given HWND). `--vo` is a priority list — mpv falls back gpu-next → gpu at
 * runtime if the driver can't init gpu-next; the startup probe in
 * `gpu-next-probe.ts` only decides the DV-reshape capability query, not this
 * list. d3d11va decodes either way.
 *
 * UNTESTED on a real Windows box: the HWND format and both VOs need verifying.
 */
export class Win32EmbedBackend implements EmbedBackend {
  readonly id = 'windows';

  async resolve(videoWin: BrowserWindow): Promise<{ args: string[]; env?: NodeJS.ProcessEnv }> {
    const wid = readWindowHandle(videoWin);
    return {
      args: [`--wid=${wid}`, '--vo=gpu-next,gpu', '--hwdec=auto'],
    };
  }
}
