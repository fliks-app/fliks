import type { BrowserWindow } from 'electron';
import type { EmbedBackend } from './types';
import { readWindowHandle } from './types';
import { resolveWindowsVo } from './gpu-next-probe';

/**
 * Windows embedding via mpv's `--wid` (reparents its video output as a child of
 * the given HWND); d3d11va decodes with either VO.
 *
 * UNTESTED on a real Windows box: the HWND format and both VOs need verifying.
 */
export class Win32EmbedBackend implements EmbedBackend {
  readonly id = 'windows';

  async resolve(
    videoWin: BrowserWindow,
    mpvPath: string,
  ): Promise<{ args: string[]; env?: NodeJS.ProcessEnv }> {
    const wid = readWindowHandle(videoWin);
    // A failed probe also covers a crash or hang, which a VO list can't fall back
    // from; the list only catches a gpu-next init failure the probe didn't see.
    const vo = (await resolveWindowsVo(mpvPath)) === 'gpu-next' ? 'gpu-next,gpu' : 'gpu';
    return {
      args: [`--wid=${wid}`, `--vo=${vo}`, '--hwdec=auto'],
    };
  }
}
