import type { BrowserWindow } from 'electron';
import type { EmbedBackend } from './types';

/**
 * Linux embedding via X11 (XWayland). mpv's `--wid` reparents its video output
 * into the Electron video window's native X11 surface (Electron runs with
 * ozone-platform=x11 so getNativeWindowHandle() yields a usable XID).
 *
 * Output is the SOFTWARE X11 VO (--vo=x11), not GL. A GL VO presents via
 * DRI3/Present directly to screen, which under Mutter bypasses the compositor
 * over the video rect and draws ON TOP of the transparent UI overlay, hiding
 * the player controls. --vo=x11 pushes frames through the X server into the
 * window's backing pixmap, so Mutter composites them and the overlay (a higher
 * top-level) draws above. Trade-off: no GL/HDR display path on Linux; hardware
 * DECODE is still used via --hwdec=auto-copy (decode in HW, read back to RAM).
 * The GL/HDR display path needs the libmpv render-API re-architecture (later).
 */
export class X11EmbedBackend implements EmbedBackend {
  readonly id = 'linux-x11';

  resolve(videoWin: BrowserWindow): { args: string[]; env?: NodeJS.ProcessEnv } {
    const handle = videoWin.getNativeWindowHandle();
    const wid = handle.readUInt32LE(0); // X11 Window XID

    // `--wid` embedding is X11-only. On a Wayland session mpv would otherwise
    // pick its Wayland VO and open its OWN window, ignoring --wid. Drop
    // WAYLAND_DISPLAY for the mpv process so it uses X11 via XWayland.
    const env = { ...process.env };
    delete env.WAYLAND_DISPLAY;

    return {
      args: [
        `--wid=${wid}`,
        '--vo=x11',
        '--hwdec=auto-copy',
        '--x11-bypass-compositor=no',
      ],
      env,
    };
  }
}
