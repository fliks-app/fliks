import { isQuitting } from '../quitting';
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MpvPlayer } from '../mpv/mpv-player';
import { MacMpvPlayer } from '../mpv/mac-mpv-player';
import type { PlayerBackend } from '../mpv/player-backend';
import { createEmbedBackend } from './backends';
import { setPlaybackKeepAwake } from '../power';
import { forwardPlayerEvents } from './forward-events';
import { appendLog, echoRendererConsole } from '../log-file';
import { watchRendererCrash } from '../renderer-recovery';
import { IPC, type DesktopEvent, type DesktopRect } from '../../shared/contract';
import { loadWindowState, trackWindowState } from '../window-state';

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

const UI_CLOSE_GRACE_MS = 1500;
/** Windows 11 DWM window rounding, so the overlays' clipped bottom aligns with frameWin's. */
const WIN_OVERLAY_CORNER_RADIUS = 8;
const BLANK_PAGE = 'data:text/html,<body style="margin:0;background:transparent"></body>';

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

function uiWebPreferences(preload: string): Electron.WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    // The live event stream keeps running while the window is hidden in background mode.
    backgroundThrottling: false,
    // Trusted client: the bundled Angular app (fliks://, a secure origin)
    // must reach the user's server even when it's plain HTTP on a LAN —
    // disable web security to allow that cross-origin/mixed-content fetch,
    // the same bypass the mobile apps get via native HTTP. cors.ts still
    // reflects the ACAO header for credentialed calls.
    webSecurity: false,
  };
}

/** Windows: the frameless see-through windows pinned over frameWin's content area. */
interface Overlays {
  /** mpv's --wid child window embeds into it and shows through its (empty) transparent page. */
  video: BrowserWindow;
  /** The web UI, owned by `video` so it stays above it; its transparent regions reveal the video. */
  ui: BrowserWindow;
}

/** The framed player window and mpv. macOS draws the video under frameWin's own page, so AppKit animates both
 *  together; Windows embeds an --wid subprocess, and a framed window can't be transparent there: hence Overlays. */
export class PlayerSession {
  private frameWin!: BrowserWindow;
  private overlays: Overlays | null = null;
  private mpv: PlayerBackend | null = null;
  /** Set by destroy(); createPlayer() can await the (slow, Windows gpu-next)
   *  probe for several seconds, during which the window may already have closed. */
  private destroyed = false;
  /** Playback stopped: by the renderer (stop IPC) or by a renderer crash. */
  onStop?: () => void;
  /** Background mode: closing the window hides it instead of ending the session. */
  hideOnClose: () => boolean = () => false;
  /** The window is visible and focused (any of the session's windows). */
  onActive?: (active: boolean) => void;
  /** The framed window entered or left full screen. */
  onFullscreenChange?: () => void;

  private get uiWin(): BrowserWindow {
    return this.overlays?.ui ?? this.frameWin;
  }

  private get windows(): BrowserWindow[] {
    return this.overlays ? [this.frameWin, this.overlays.video, this.overlays.ui] : [this.frameWin];
  }

  async start(opts: PlayerSessionOptions): Promise<void> {
    const { rendererUrl, preloadPath, iconPath } = opts;
    const singleWindow = process.platform === 'darwin';
    const saved = singleWindow ? loadWindowState() : null;
    this.frameWin = new BrowserWindow({
      width: 1280,
      height: 800,
      ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : {}),
      minWidth: 800,
      minHeight: 500,
      // Windows: brand at startup, black on the first frame. macOS: the page is see-through over the video layer.
      ...(singleWindow ? { backgroundColor: '#00000000' } : { backgroundColor: '#1d232a' }),
      title: 'Fliks',
      ...(iconPath ? { icon: iconPath } : {}),
      // macOS: shown once the page paints, since the clear background would show the system one until then.
      ...(singleWindow ? { webPreferences: uiWebPreferences(preloadPath), show: false } : {}),
    });
    if (singleWindow) {
      this.frameWin.on('page-title-updated', (e) => e.preventDefault());
      this.frameWin.once('ready-to-show', () => {
        this.frameWin.show();
        if (saved?.maximized) this.frameWin.maximize();
        if (saved?.fullscreen) this.frameWin.setFullScreen(true);
      });
    } else this.overlays = await this.createOverlays(preloadPath);

    const ui = this.uiWin;
    echoRendererConsole(ui.webContents);
    watchRendererCrash(ui.webContents, {
      appUrl: rendererUrl,
      stopPlayback: async () => {
        setPlaybackKeepAwake(false);
        this.onStop?.();
        await this.mpv?.stop();
      },
      log: appendLog,
    });
    ui.webContents.on('unresponsive', () => console.error('[ui] unresponsive'));

    this.frameWin.on('enter-full-screen', () => this.fullscreenChanged(true));
    this.frameWin.on('leave-full-screen', () => this.fullscreenChanged(false));
    this.frameWin.on('close', (e) => {
      if (this.destroyed || ui.isDestroyed()) return;
      if (this.hideOnClose()) {
        e.preventDefault();
        this.hide();
        return;
      }
      // macOS keeps the app alive in the dock. A hidden full-screen window would leave an empty Space.
      if (process.platform === 'darwin' && !isQuitting()) {
        e.preventDefault();
        if (this.frameWin.isFullScreen()) {
          this.frameWin.once('leave-full-screen', () => this.hide());
          this.frameWin.setFullScreen(false);
        } else this.hide();
        return;
      }
      // A renderer stuck in its unload handlers must not keep the app from quitting.
      setTimeout(() => void this.destroy(), UI_CLOSE_GRACE_MS);
      if (ui === this.frameWin) return;
      // Close the UI first so its unload handlers (position save, session stop) run before destroy() kills it.
      e.preventDefault();
      ui.once('closed', () => void this.destroy());
      ui.close();
    });
    this.frameWin.on('closed', () => this.destroy());
    this.watchActive();
    if (singleWindow) trackWindowState(this.frameWin);
    // Quit closes every window from Electron's own loop, and destroy() tearing the siblings down
    // inside it frees a window that loop still holds: close ours first, window-all-closed then quits.
    app.on('before-quit', (e) => {
      if (this.destroyed || this.frameWin.isDestroyed()) return;
      e.preventDefault();
      this.frameWin.close();
    });

    await ui.loadURL(rendererUrl);

    const mpv = await this.createPlayer();
    if (this.destroyed) {
      await mpv.destroy().catch(() => {});
      return;
    }
    this.mpv = mpv;
    // A video gap (decoder re-init on a seek) then reads as loading, not a brand flash.
    forwardPlayerEvents(this.mpv, (e) => this.emit(e), this.overlays ? () => {
      if (!this.frameWin.isDestroyed()) this.frameWin.setBackgroundColor('#000000');
    } : undefined);
    await this.mpv.start();
    this.emit({ type: 'ready' });
  }

  private async createOverlays(preloadPath: string): Promise<Overlays> {
    await this.frameWin.loadURL(BLANK_PAGE);
    const overlay = {
      ...this.frameWin.getContentBounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      // Electron warns that resizing a transparent window can break its transparency; sync() re-fits it.
      resizable: false,
      skipTaskbar: true,
    };
    const video = new BrowserWindow({ ...overlay, parent: this.frameWin, title: 'Fliks' });
    await video.loadURL(BLANK_PAGE);
    const ui = new BrowserWindow({
      ...overlay,
      parent: video,
      title: 'Fliks UI',
      webPreferences: uiWebPreferences(preloadPath),
    });

    // Keep the video + UI layers exactly over the framed window's content area.
    const sync = () => {
      if (ui.isDestroyed() || video.isDestroyed() || this.frameWin.isDestroyed()) return;
      const b = this.frameWin.getContentBounds();
      video.setBounds(b);
      // Windows turns a transparent window OPAQUE once it covers the full
      // display (Electron #27286), which would black out the controls layer in
      // fullscreen. Shave 1px so the overlay stays under display size + keeps
      // its transparency; the video underneath still fills the screen.
      const fs = this.frameWin.isFullScreen();
      const u = { ...b, height: fs ? b.height - 1 : b.height };
      ui.setBounds(u);
      // frameWin rounds its bottom via DWM; clip the square overlays to match (edge-to-edge in fullscreen).
      video.setShape(fs ? [] : roundedBottomShape(b.width, b.height));
      ui.setShape(fs ? [] : roundedBottomShape(u.width, u.height));
    };
    // All these window events take a `() => void` listener; cast to one literal
    // so the overload resolves (a union of event names matches none).
    for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen'] as const) {
      this.frameWin.on(ev as 'resize', sync);
    }
    // 'leave-full-screen' fires before the windowed frame is restored: re-fit once it has committed,
    // or the overlays stay at full-display size over the caption buttons.
    this.frameWin.on('leave-full-screen', () => {
      sync();
      setTimeout(sync, 0);
      setTimeout(sync, 150);
    });
    // Shaped before the (slow) Angular load, so the corners are rounded from the first painted frame.
    sync();
    ui.webContents.once('did-finish-load', sync);
    return { video, ui };
  }

  /**
   * Pick the playback backend for the current OS:
   *   • macOS — in-process libmpv rendered into a CAMetalLayer inside the framed
   *     window (mpv's subprocess ignores --wid there).
   *   • Windows — an mpv subprocess embedded into the video overlay via the
   *     platform EmbedBackend's args.
   */
  private async createPlayer(): Promise<PlayerBackend> {
    if (!this.overlays) return new MacMpvPlayer(this.frameWin);
    const mpvPath = resolveBundledMpv() ?? 'mpv';
    const backend = createEmbedBackend();
    const { args, env } = await backend.resolve(this.overlays.video, mpvPath);
    return new MpvPlayer({ baseArgs: args, env, mpvPath });
  }

  private emit(event: DesktopEvent): void {
    if (this.frameWin && !this.uiWin.isDestroyed()) {
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

  /** Brings the framed window back to the front, e.g. after the browser step of an SSO sign-in. */
  focus(): void {
    if (this.frameWin.isDestroyed()) return;
    if (this.frameWin.isMinimized()) this.frameWin.restore();
    for (const w of this.windows) if (!w.isDestroyed()) w.show();
    this.frameWin.focus();
  }

  hide(): void {
    for (const w of [...this.windows].reverse()) if (!w.isDestroyed()) w.hide();
    this.onActive?.(false);
  }

  setOverlay(icon: Electron.NativeImage | null, description: string): void {
    if (!this.frameWin.isDestroyed()) this.frameWin.setOverlayIcon(icon, description);
  }

  /** Focus moves between the session's windows, so the verdict waits for it to settle. */
  private watchActive(): void {
    let timer: NodeJS.Timeout | undefined;
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (this.destroyed || this.frameWin.isDestroyed()) return;
        const wins = this.windows.filter((w) => !w.isDestroyed());
        this.onActive?.(this.frameWin.isVisible() && !this.frameWin.isMinimized() && wins.some((w) => w.isFocused()));
      }, 100);
    };
    for (const w of this.windows) {
      w.on('focus', settle);
      w.on('blur', settle);
      w.on('show', settle);
      w.on('minimize', settle);
      w.on('restore', settle);
    }
  }

  /** The page's contents, for what the main process injects into it or fetches as it. */
  get uiContents(): Electron.WebContents {
    return this.uiWin.webContents;
  }

  resize(rect: DesktopRect): void {
    if (!this.frameWin.isDestroyed()) this.frameWin.setBounds(rect);
  }

  isFullscreen(): boolean {
    return !!this.frameWin && !this.frameWin.isDestroyed() && this.frameWin.isFullScreen();
  }

  private fullscreenChanged(fullscreen: boolean): void {
    this.emit({ type: 'fullscreenChanged', payload: { fullscreen } });
    this.onFullscreenChange?.();
  }

  setFullscreen(enabled: boolean): void {
    if (!this.frameWin.isDestroyed()) this.frameWin.setFullScreen(enabled);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    setPlaybackKeepAwake(false);
    this.onStop?.();
    // The windows go even when the player's teardown throws, or quit would hang on them.
    try {
      await this.mpv?.destroy();
    } catch (e) {
      console.error('[player] teardown failed', e);
    }
    this.mpv = null;
    for (const w of [...this.windows].reverse()) if (!w.isDestroyed()) w.destroy();
  }
}
