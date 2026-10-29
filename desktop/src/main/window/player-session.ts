import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MpvPlayer } from '../mpv/mpv-player';
import { MacMpvPlayer, roundWindowBottomCorners } from '../mpv/mac-mpv-player';
import type { PlayerBackend } from '../mpv/player-backend';
import { createEmbedBackend } from './backends';
import { setPlaybackKeepAwake } from '../power';
import { forwardPlayerEvents } from './forward-events';
import { appendLog, echoRendererConsole } from '../log-file';
import { watchRendererCrash } from '../renderer-recovery';
import { IPC, type DesktopEvent, type DesktopRect } from '../../shared/contract';

/**
 * Path to a vendored mpv BINARY for the embed (--wid) path, or undefined to
 * fall back to `mpv` on PATH. Mirrors the Linux libmpv vendoring: a static mpv
 * at native/vendor/mpv (macOS) or native/vendor/mpv.exe (Windows), which
 * electron-builder ships + asarUnpacks via the native/vendor/** glob.
 */
export function resolveBundledMpv(): string | undefined {
  const base = app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath();
  const bin = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  const bundled = path.join(base, 'native', 'vendor', bin);
  return fs.existsSync(bundled) ? bundled : undefined;
}

export interface PlayerSessionOptions {
  rendererUrl: string;
  preloadPath: string;
  iconPath?: string;
}

/** Window corner radius matching each OS's native window rounding, so the
 *  overlays' clipped bottom aligns with frameWin's rounded bottom: macOS ~10pt,
 *  Windows 11 DWM ~8px. */
const UI_CLOSE_GRACE_MS = 1500;
const OVERLAY_CORNER_RADIUS = 10;
const WIN_OVERLAY_CORNER_RADIUS = 8;

/** Windows: a square-top / rounded-bottom window region as a horizontal-slice
 *  staircase (setShape/SetWindowRgn has no anti-aliasing, so the curve is
 *  stepped — imperceptible at this radius). Coordinates are the window's own. */
function roundedBottomShape(width: number, height: number): Electron.Rectangle[] {
  const r = Math.max(0, Math.min(WIN_OVERLAY_CORNER_RADIUS, Math.floor(Math.min(width, height) / 2)));
  if (r === 0) return [];
  const rects: Electron.Rectangle[] = [{ x: 0, y: 0, width, height: height - r }];
  for (let i = 0; i < r; i++) {
    const o = i + 0.5; // sample mid-row for a smoother step
    const inset = Math.round(r - Math.sqrt(r * r - o * o));
    rects.push({ x: inset, y: height - r + i, width: width - 2 * inset, height: 1 });
  }
  return rects;
}

/**
 * Owns three stacked, geometry-synced windows and the mpv player:
 *   • frameWin — the FRAMED master window (native title bar, min/maximize/close,
 *     taskbar entry, icon, resize). Opaque; the user drives every window
 *     operation through it. Its content area is fully covered by videoWin.
 *   • videoWin — frameless transparent window owned by frameWin, pinned over
 *     frameWin's content area. mpv embeds into it and shows through its (empty)
 *     transparent web content. A transparent window can't be framed on Windows,
 *     so the native frame and the see-through video layer must be separate
 *     stacked windows.
 *   • uiWin — frameless transparent window owned by videoWin, pinned over the
 *     same area, hosting the web UI. Its transparent regions reveal the video
 *     below; the app's own opaque pages cover it while browsing.
 */
export class PlayerSession {
  private frameWin!: BrowserWindow;
  private videoWin!: BrowserWindow;
  private uiWin!: BrowserWindow;
  private mpv: PlayerBackend | null = null;
  /** Set by destroy(); createPlayer() can await the (slow, Windows gpu-next)
   *  probe for several seconds, during which the window may already have closed. */
  private destroyed = false;
  /** Playback stopped: by the renderer (stop IPC) or by a renderer crash. */
  onStop?: () => void;

  async start(opts: PlayerSessionOptions): Promise<void> {
    const { rendererUrl, preloadPath, iconPath } = opts;
    this.frameWin = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 500,
      backgroundColor: '#1d232a', // brand at startup; set black on first frame so a video gap reads as loading
      title: 'Fliks',
      ...(iconPath ? { icon: iconPath } : {}),
    });
    await this.frameWin.loadURL(
      'data:text/html,<body style="margin:0;background:transparent"></body>',
    );

    this.videoWin = new BrowserWindow({
      ...this.frameWin.getContentBounds(),
      // Transparent so the embedded mpv child window shows through its (empty)
      // web content; otherwise the opaque page covers the video. On Windows a
      // transparent window must be frameless — frameWin carries the chrome.
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      skipTaskbar: true,
      // Owned by frameWin: stays above it (over its content area) and hides /
      // closes with it, without its own taskbar entry.
      parent: this.frameWin,
      title: 'Fliks',
    });
    await this.videoWin.loadURL(
      'data:text/html,<body style="margin:0;background:transparent"></body>',
    );

    this.uiWin = new BrowserWindow({
      ...this.frameWin.getContentBounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      // Electron warns that resizing a transparent window can break its
      // transparency on some platforms; the overlay is re-fitted via setBounds
      // in sync(), so keep the user from resizing it directly.
      resizable: false,
      // Owned by videoWin: stays above it (so the controls draw over the video)
      // without a global always-on-top.
      skipTaskbar: true,
      parent: this.videoWin,
      title: 'Fliks UI',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: true,
        // Trusted client: the bundled Angular app (fliks://, a secure origin)
        // must reach the user's server even when it's plain HTTP on a LAN —
        // disable web security to allow that cross-origin/mixed-content fetch,
        // the same bypass the mobile apps get via native HTTP. cors.ts still
        // reflects the ACAO header for credentialed calls.
        webSecurity: false,
      },
    });

    echoRendererConsole(this.uiWin.webContents);
    watchRendererCrash(this.uiWin.webContents, {
      appUrl: rendererUrl,
      stopPlayback: async () => {
        setPlaybackKeepAwake(false);
        this.onStop?.();
        await this.mpv?.stop();
      },
      log: appendLog,
    });
    this.uiWin.webContents.on('unresponsive', () =>
      console.error('[uiWin] unresponsive'),
    );


    // Keep the video + UI layers exactly over the framed window's content area.
    const sync = () => {
      if (
        this.uiWin.isDestroyed() ||
        this.videoWin.isDestroyed() ||
        this.frameWin.isDestroyed()
      )
        return;
      const b = this.frameWin.getContentBounds();
      this.videoWin.setBounds(b);
      // Windows turns a transparent window OPAQUE once it covers the full
      // display (Electron #27286), which would black out the controls layer in
      // fullscreen. Shave 1px so the overlay stays under display size + keeps
      // its transparency; the video underneath still fills the screen.
      const u = { ...b };
      if (process.platform === 'win32' && this.frameWin.isFullScreen()) u.height -= 1;
      this.uiWin.setBounds(u);
      // frameWin rounds its bottom natively (macOS) / via DWM (Win11); clip the
      // square overlays to match so the video + UI don't overhang it. Re-applied
      // here so the shape tracks every resize. Skip in fullscreen (edge-to-edge).
      const fs = this.frameWin.isFullScreen();
      if (process.platform === 'darwin') {
        const r = fs ? 0 : OVERLAY_CORNER_RADIUS;
        roundWindowBottomCorners(this.videoWin, r);
        roundWindowBottomCorners(this.uiWin, r);
      } else if (process.platform === 'win32') {
        this.videoWin.setShape(fs ? [] : roundedBottomShape(b.width, b.height));
        this.uiWin.setShape(fs ? [] : roundedBottomShape(u.width, u.height));
      }
    };
    // All these window events take a `() => void` listener; cast to one literal
    // so the overload resolves (a union of event names matches none).
    for (const ev of [
      'move',
      'resize',
      'maximize',
      'unmaximize',
      'restore',
      'enter-full-screen',
    ] as const) {
      this.frameWin.on(ev as 'resize', sync);
    }
    // On Windows, 'leave-full-screen' fires BEFORE the windowed frame is
    // restored (Electron applies the size after notifying), so a synchronous
    // getContentBounds() still returns the full-display rect. sync() would then
    // pin the transparent video/UI overlays over the title bar, covering the
    // native caption buttons, with no later event guaranteed to correct it.
    // Re-fit once the restore has committed. macOS reports settled bounds at the
    // event already, so it needs only the synchronous pass; the deferred ones
    // are idempotent no-ops (sync() guards isDestroyed()).
    this.frameWin.on('leave-full-screen', () => {
      sync();
      if (process.platform === 'win32') {
        setTimeout(sync, 0);
        setTimeout(sync, 150);
      }
    });
    // Close the UI first so its unload handlers (position save, session stop) run before destroy() kills it.
    this.frameWin.on('close', (e) => {
      if (this.destroyed || this.uiWin.isDestroyed()) return;
      e.preventDefault();
      this.uiWin.once('closed', () => void this.destroy());
      this.uiWin.close();
      setTimeout(() => void this.destroy(), UI_CLOSE_GRACE_MS);
    });
    this.frameWin.on('closed', () => this.destroy());
    // Quit closes every window from Electron's own loop, and destroy() tearing the siblings down
    // inside it frees a window that loop still holds: close ours first, window-all-closed then quits.
    app.on('before-quit', (e) => {
      if (this.destroyed || this.frameWin.isDestroyed()) return;
      e.preventDefault();
      this.frameWin.close();
    });

    // Shape + position the overlays BEFORE awaiting the (slow) Angular load, so
    // the corners are rounded from the first painted frame instead of showing
    // square for the ~0.5s the app takes to load.
    sync();
    await this.uiWin.loadURL(rendererUrl);
    sync();

    // The video window's native handle is only valid once it has painted.
    const mpv = await this.createPlayer();
    if (this.destroyed) {
      await mpv.destroy().catch(() => {});
      return;
    }
    this.mpv = mpv;
    // A video gap (decoder re-init on a seek) then reads as loading, not a brand flash.
    forwardPlayerEvents(this.mpv, (e) => this.emit(e), () => {
      if (!this.frameWin.isDestroyed()) this.frameWin.setBackgroundColor('#000000');
    });
    await this.mpv.start();
    this.emit({ type: 'ready' });
  }

  /**
   * Pick the playback backend for the current OS:
   *   • macOS — in-process libmpv rendered into a CAOpenGLLayer on the video
   *     window's NSView (mpv's subprocess ignores --wid there).
   *   • Windows (and other --wid embed platforms) — an mpv subprocess embedded
   *     via the platform EmbedBackend's args.
   */
  private async createPlayer(): Promise<PlayerBackend> {
    if (process.platform === 'darwin') return new MacMpvPlayer(this.videoWin);
    const mpvPath = resolveBundledMpv() ?? 'mpv';
    const backend = createEmbedBackend();
    const { args, env } = await backend.resolve(this.videoWin, mpvPath);
    return new MpvPlayer({ baseArgs: args, env, mpvPath });
  }

  private emit(event: DesktopEvent): void {
    if (this.uiWin && !this.uiWin.isDestroyed()) {
      this.uiWin.webContents.send(IPC.event, event);
    }
  }

  /** The mpv player; throws if accessed before start() completes. */
  get player(): PlayerBackend {
    if (!this.mpv) throw new Error('player not started');
    return this.mpv;
  }

  /** The framed window's native handle, which the OS media controls bind to. */
  get windowHandle(): Buffer {
    return this.frameWin.getNativeWindowHandle();
  }

  /** The page's contents, for what the main process injects into it or fetches as it. */
  get uiContents(): Electron.WebContents {
    return this.uiWin.webContents;
  }

  resize(rect: DesktopRect): void {
    if (!this.frameWin.isDestroyed()) this.frameWin.setBounds(rect);
  }

  setFullscreen(enabled: boolean): void {
    // The framed window goes fullscreen; the enter/leave-full-screen listeners
    // re-sync the video + UI layers onto its content area (full screen).
    if (!this.frameWin.isDestroyed()) this.frameWin.setFullScreen(enabled);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    setPlaybackKeepAwake(false);
    await this.mpv?.destroy();
    this.mpv = null;
    if (this.uiWin && !this.uiWin.isDestroyed()) this.uiWin.destroy();
    if (this.videoWin && !this.videoWin.isDestroyed()) this.videoWin.destroy();
    if (this.frameWin && !this.frameWin.isDestroyed()) this.frameWin.destroy();
  }
}
