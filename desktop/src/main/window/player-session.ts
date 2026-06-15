import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MpvPlayer } from '../mpv/mpv-player';
import { createEmbedBackend } from './backends';
import { IPC, type DesktopEvent, type DesktopRect } from '../../shared/contract';

/**
 * Path to a vendored mpv BINARY for the embed (--wid) path, or undefined to
 * fall back to `mpv` on PATH. Mirrors the Linux libmpv vendoring: a static mpv
 * at native/vendor/mpv (macOS) or native/vendor/mpv.exe (Windows), which
 * electron-builder ships + asarUnpacks via the native/vendor/** glob.
 */
function resolveBundledMpv(): string | undefined {
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

/**
 * Owns the two stacked, geometry-synced windows and the mpv player:
 *   • videoWin — the FRAMED main window (title bar, close, taskbar entry,
 *     icon). Opaque; mpv embeds into its content area via the platform backend.
 *   • uiWin — frameless transparent child pinned over videoWin's content area,
 *     hosting the web UI. Its transparent regions reveal the video below; the
 *     app's own opaque pages cover it while browsing.
 */
export class PlayerSession {
  private videoWin!: BrowserWindow;
  private uiWin!: BrowserWindow;
  private mpv: MpvPlayer | null = null;

  async start(opts: PlayerSessionOptions): Promise<void> {
    const { rendererUrl, preloadPath, iconPath } = opts;
    this.videoWin = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 500,
      frame: true,
      backgroundColor: '#1d232a', // Fliks brand background
      title: 'Fliks',
      ...(iconPath ? { icon: iconPath } : {}),
    });
    await this.videoWin.loadURL(
      'data:text/html,<body style="margin:0;background:%231d232a"></body>',
    );

    this.uiWin = new BrowserWindow({
      ...this.videoWin.getContentBounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // Electron warns that resizing a transparent window can break its
      // transparency on some platforms; the overlay is re-fitted via setBounds
      // in sync(), so keep the user from resizing it directly.
      resizable: false,
      // Child of videoWin: stays above its parent (so the controls draw over
      // the software-composited video) without a global always-on-top, and the
      // framed videoWin keeps the title bar + taskbar entry.
      skipTaskbar: true,
      parent: this.videoWin,
      title: 'Fliks UI',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        sandbox: false,
      },
    });

    // Surface the Angular app's console (device detection, engine selection,
    // errors) in the main process log.
    this.uiWin.webContents.on('console-message', (_e, _level, message) => {
      console.log('[renderer]', message);
    });
    this.uiWin.webContents.on('render-process-gone', (_e, details) =>
      console.error('[uiWin render-process-gone]', JSON.stringify(details)),
    );
    this.uiWin.webContents.on('unresponsive', () =>
      console.error('[uiWin] unresponsive'),
    );


    // Keep the transparent UI exactly over the framed window's content area.
    const sync = () => {
      if (this.uiWin.isDestroyed() || this.videoWin.isDestroyed()) return;
      const b = this.videoWin.getContentBounds();
      // Windows turns a transparent window OPAQUE once it covers the full
      // display (Electron #27286), which would black out the controls layer in
      // fullscreen. Shave 1px so the overlay stays under display size + keeps
      // its transparency; the video underneath still fills the screen.
      if (process.platform === 'win32' && this.videoWin.isFullScreen()) b.height -= 1;
      this.uiWin.setBounds(b);
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
      'leave-full-screen',
    ] as const) {
      this.videoWin.on(ev as 'resize', sync);
    }
    this.videoWin.on('closed', () => this.destroy());

    await this.uiWin.loadURL(rendererUrl);
    sync();

    // The video window's native handle is only valid once it has painted.
    const backend = createEmbedBackend();
    const { args, env } = backend.resolve(this.videoWin);
    this.mpv = new MpvPlayer({ baseArgs: args, env, mpvPath: resolveBundledMpv() });
    this.forwardEvents(this.mpv);
    await this.mpv.start();
    this.emit({ type: 'ready' });
  }

  private forwardEvents(mpv: MpvPlayer): void {
    mpv.on('log', (s: string) => process.stderr.write(`[mpv] ${s}`));
    mpv.on('exit', (e) => console.error('[mpv] process exit', JSON.stringify(e)));
    mpv.on('stateChanged', (p) => {
      console.log('[player] state:', (p as { state?: string }).state);
      this.emit({ type: 'stateChanged', payload: p });
    });
    mpv.on('timeUpdate', (p) => this.emit({ type: 'timeUpdate', payload: p }));
    mpv.on('tracksChanged', (p) => {
      console.log('[player] tracks:', JSON.stringify(p));
      this.emit({ type: 'tracksChanged', payload: p });
    });
    mpv.on('firstFrame', () => {
      console.log('[player] firstFrame');
      this.emit({ type: 'firstFrame' });
    });
    mpv.on('error', (p) => {
      console.log('[player] error:', JSON.stringify(p));
      this.emit({ type: 'error', payload: p });
    });
  }

  private emit(event: DesktopEvent): void {
    if (this.uiWin && !this.uiWin.isDestroyed()) {
      this.uiWin.webContents.send(IPC.event, event);
    }
  }

  /** The mpv player; throws if accessed before start() completes. */
  get player(): MpvPlayer {
    if (!this.mpv) throw new Error('player not started');
    return this.mpv;
  }

  resize(rect: DesktopRect): void {
    if (!this.videoWin.isDestroyed()) this.videoWin.setBounds(rect);
  }

  setFullscreen(enabled: boolean): void {
    // The framed window goes fullscreen; the enter/leave-full-screen listeners
    // re-sync the transparent UI overlay onto its content area, and mpv (embedded
    // in that window) follows.
    if (!this.videoWin.isDestroyed()) this.videoWin.setFullScreen(enabled);
  }

  async destroy(): Promise<void> {
    await this.mpv?.destroy();
    this.mpv = null;
    if (this.uiWin && !this.uiWin.isDestroyed()) this.uiWin.destroy();
    if (this.videoWin && !this.videoWin.isDestroyed()) this.videoWin.destroy();
  }
}
