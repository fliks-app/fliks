import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { MpvPlayer } from '../mpv/mpv-player';
import { MacMpvPlayer } from '../mpv/mac-mpv-player';
import type { PlayerBackend } from '../mpv/player-backend';
import { createEmbedBackend } from './backends';
import { setPlaybackKeepAwake, keepAwakeForState } from '../power';
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
        sandbox: false,
        // Trusted client: the bundled Angular app (fliks://, a secure origin)
        // must reach the user's server even when it's plain HTTP on a LAN —
        // disable web security to allow that cross-origin/mixed-content fetch,
        // the same bypass the mobile apps get via native HTTP. cors.ts still
        // reflects the ACAO header for credentialed calls.
        webSecurity: false,
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
    this.frameWin.on('closed', () => this.destroy());

    await this.uiWin.loadURL(rendererUrl);
    sync();

    // The video window's native handle is only valid once it has painted.
    this.mpv = this.createPlayer();
    this.forwardEvents(this.mpv);
    await this.mpv.start();
    this.emit({ type: 'ready' });
  }

  /**
   * Pick the playback backend for the current OS:
   *   • macOS — in-process libmpv rendered into a CAOpenGLLayer on the video
   *     window's NSView (mpv's subprocess --wid crashes there).
   *   • Windows (and other --wid embed platforms) — an mpv subprocess embedded
   *     via the platform EmbedBackend's args.
   */
  private createPlayer(): PlayerBackend {
    if (process.platform === 'darwin') return new MacMpvPlayer(this.videoWin);
    const backend = createEmbedBackend();
    const { args, env } = backend.resolve(this.videoWin);
    return new MpvPlayer({ baseArgs: args, env, mpvPath: resolveBundledMpv() });
  }

  private forwardEvents(mpv: PlayerBackend): void {
    mpv.on('log', (s: string) => process.stderr.write(`[${Date.now()}][mpv] ${s}`));
    mpv.on('exit', (e) => console.error('[mpv] process exit', JSON.stringify(e)));
    mpv.on('stateChanged', (p) => {
      console.log('[player] state:', p.state);
      setPlaybackKeepAwake(keepAwakeForState(p.state));
      this.emit({ type: 'stateChanged', payload: p });
    });
    mpv.on('timeUpdate', (p) => this.emit({ type: 'timeUpdate', payload: p }));
    mpv.on('tracksChanged', (p) => {
      console.log('[player] tracks:', JSON.stringify(p));
      this.emit({ type: 'tracksChanged', payload: p });
    });
    mpv.on('firstFrame', () => {
      console.log('[player] firstFrame');
      setPlaybackKeepAwake(true);
      // Now that playback owns the window, paint the frame black: a video gap
      // (decoder re-init on a seek) then reads as loading, not a brand flash.
      if (!this.frameWin.isDestroyed()) this.frameWin.setBackgroundColor('#000000');
      this.emit({ type: 'firstFrame' });
    });
    mpv.on('error', (p) => {
      console.log('[player] error:', JSON.stringify(p));
      setPlaybackKeepAwake(false);
      this.emit({ type: 'error', payload: p });
    });
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

  resize(rect: DesktopRect): void {
    if (!this.frameWin.isDestroyed()) this.frameWin.setBounds(rect);
  }

  setFullscreen(enabled: boolean): void {
    // The framed window goes fullscreen; the enter/leave-full-screen listeners
    // re-sync the video + UI layers onto its content area (full screen).
    if (!this.frameWin.isDestroyed()) this.frameWin.setFullScreen(enabled);
  }

  async destroy(): Promise<void> {
    setPlaybackKeepAwake(false);
    await this.mpv?.destroy();
    this.mpv = null;
    if (this.uiWin && !this.uiWin.isDestroyed()) this.uiWin.destroy();
    if (this.videoWin && !this.videoWin.isDestroyed()) this.videoWin.destroy();
    if (this.frameWin && !this.frameWin.isDestroyed()) this.frameWin.destroy();
  }
}
