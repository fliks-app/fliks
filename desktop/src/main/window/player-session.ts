import { BrowserWindow } from 'electron';
import { MpvPlayer } from '../mpv/mpv-player';
import { createEmbedBackend } from './backends';
import { IPC, type DesktopEvent, type DesktopRect } from '../../shared/contract';

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
      if (!this.uiWin.isDestroyed() && !this.videoWin.isDestroyed()) {
        this.uiWin.setBounds(this.videoWin.getContentBounds());
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
    this.mpv = new MpvPlayer({ baseArgs: args, env });
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

  async destroy(): Promise<void> {
    await this.mpv?.destroy();
    this.mpv = null;
    if (this.uiWin && !this.uiWin.isDestroyed()) this.uiWin.destroy();
    if (this.videoWin && !this.videoWin.isDestroyed()) this.videoWin.destroy();
  }
}
