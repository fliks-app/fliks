import type { BrowserWindow } from 'electron';
import type { EmbedBackend } from './types';
import { resolveWindowsVo } from './gpu-next-probe';

/**
 * Windows embedding. mpv's `--wid` takes the framed window's HWND (Electron
 * returns it from getNativeWindowHandle); mpv reparents its video output as a
 * child of that window and renders with gpu-next (D3D11 via libplacebo),
 * which reshapes Dolby Vision through its FFmpeg-decoded RPU, when the driver
 * supports it; `resolveWindowsVo` falls back to plain `--vo=gpu` otherwise.
 * d3d11va does the hardware decode either way.
 *
 * UNTESTED on a real Windows box — the HWND format and the VO choice need
 * verifying on a device (see PR notes).
 */
export class Win32EmbedBackend implements EmbedBackend {
  readonly id = 'windows';

  async resolve(
    videoWin: BrowserWindow,
    mpvPath: string,
  ): Promise<{ args: string[]; env?: NodeJS.ProcessEnv }> {
    const handle = videoWin.getNativeWindowHandle();
    // The HWND lives in the low dword even on win64; mpv parses --wid as a signed
    // int and REJECTS negative values, so read it as an unsigned 32-bit (the high
    // dword is sign-extension padding) — mirrors x11.ts. mpv docs: "Pass it as
    // value cast to uint32_t (all Windows handles are 32-bit)".
    const wid = handle.readUInt32LE(0);
    const vo = await resolveWindowsVo(mpvPath);
    return {
      args: [`--wid=${wid}`, `--vo=${vo}`, '--hwdec=auto'],
    };
  }
}
