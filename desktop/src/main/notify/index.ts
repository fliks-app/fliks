import { app, ipcMain, Menu, nativeImage, net, Notification, Tray } from 'electron';
import { NOTIFY_IPC } from '../../shared/contract';
import type { DesktopNotification, DesktopNotificationAction, DesktopNotifyPrefs } from '../../shared/contract';
import { setStartAtLogin, startedAtLogin } from './autostart';
import { labels } from './labels';
import { loadPrefs, savePrefs } from './prefs';
import { parseBadge, parseNotification, parsePrefsPatch } from './validate';

const IMAGE_TIMEOUT_MS = 4000;
const IMAGE_MAX_BYTES = 2_000_000;

/** What the platform's window code gives the notifier; set once the window exists. */
export interface NotifyHost {
  show(): void;
  hide(): void;
  /** Linux: the compositor decides what its close button does. */
  setHideOnClose?(on: boolean): void;
  /** Windows: the taskbar overlay; null clears it. */
  setOverlay?(icon: Electron.NativeImage | null, description: string): void;
  sendToPage(channel: string, payload: unknown): void;
}

/** A failure to fetch the picture is a notification without one. */
async function fetchImage(path: string, serverUrl: string): Promise<Electron.NativeImage | undefined> {
  try {
    const res = await net.fetch(new URL(path, serverUrl).href, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > IMAGE_MAX_BYTES) return undefined;
    const img = nativeImage.createFromBuffer(buf);
    return img.isEmpty() ? undefined : img;
  } catch {
    return undefined;
  }
}

/** A red dot for the Windows taskbar overlay (BGRA). */
function dotIcon(): Electron.NativeImage {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x - c) ** 2 + (y - c) ** 2 <= (size / 2 - 1) ** 2) buf.set([60, 60, 224, 255], (y * size + x) * 4);
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

export class Notifier {
  private host: NotifyHost | null = null;
  private prefs = loadPrefs();
  private tray: Tray | null = null;
  private active = true;
  private quitting = false;
  private readonly live = new Map<string, Electron.Notification>();
  private readonly shown = new Set<Electron.Notification>();

  constructor(private readonly trayIcon: string | undefined) {
    app.on('before-quit', () => (this.quitting = true));
    app.on('activate', () => this.host?.show());
    ipcMain.handle(NOTIFY_IPC.show, (_e, n: unknown) => this.show(parseNotification(n)));
    ipcMain.handle(NOTIFY_IPC.setBadge, (_e, count: unknown) => this.setBadge(parseBadge(count)));
    ipcMain.handle(NOTIFY_IPC.getPrefs, () => this.prefs);
    ipcMain.handle(NOTIFY_IPC.setPrefs, (_e, patch: unknown) => this.setPrefs(parsePrefsPatch(patch)));
    ipcMain.handle(NOTIFY_IPC.windowActive, () => this.active);
  }

  /** Closing the window hides it instead of quitting; a real quit always closes. */
  hideOnClose(): boolean {
    return this.prefs.background && !this.quitting;
  }

  attach(host: NotifyHost): void {
    this.host = host;
    host.setHideOnClose?.(this.prefs.background);
    this.syncTray();
    if (this.prefs.startAtLogin) this.persistLogin(true);
    if (this.prefs.background && startedAtLogin()) host.hide();
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.host?.sendToPage(NOTIFY_IPC.active, active);
  }

  private persistLogin(on: boolean): void {
    const actual = setStartAtLogin(on);
    if (actual !== on) console.error('[notify] start at login did not stick');
    if (actual !== this.prefs.startAtLogin) {
      this.prefs = { ...this.prefs, startAtLogin: actual };
      savePrefs(this.prefs);
    }
  }

  private setPrefs(patch: Partial<DesktopNotifyPrefs>): DesktopNotifyPrefs {
    const before = this.prefs;
    this.prefs = { ...before, ...patch };
    savePrefs(this.prefs);
    if (patch.background !== undefined) {
      this.host?.setHideOnClose?.(this.prefs.background);
      this.syncTray();
      if (!this.prefs.background) this.host?.show();
    }
    if (patch.startAtLogin !== undefined) this.persistLogin(this.prefs.startAtLogin);
    return this.prefs;
  }

  private syncTray(): void {
    if (!this.prefs.background) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (this.tray || !this.trayIcon) return;
    const size = process.platform === 'darwin' ? 18 : 32;
    this.tray = new Tray(nativeImage.createFromPath(this.trayIcon).resize({ width: size, height: size }));
    const l = labels();
    this.tray.setToolTip(app.getName());
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: l.open, click: () => this.host?.show() },
        { label: l.quit, click: () => app.quit() },
      ]),
    );
    this.tray.on('click', () => this.host?.show());
  }

  private setBadge(count: number): void {
    if (process.platform === 'win32') this.host?.setOverlay?.(count > 0 ? dotIcon() : null, labels().notifications);
    else app.setBadgeCount(count);
  }

  private async show(n: DesktopNotification): Promise<void> {
    if (!Notification.isSupported()) return;
    const icon = n.image ? await fetchImage(n.image, n.serverUrl) : undefined;
    const notification = new Notification({
      title: n.title,
      body: n.body,
      ...(icon ? { icon } : {}),
      actions: n.actions.map((a) => ({ type: 'button' as const, text: a.title })),
    });
    const click = (action?: DesktopNotificationAction) => {
      this.host?.show();
      this.host?.sendToPage(NOTIFY_IPC.click, { url: n.url, serverUrl: n.serverUrl, user: n.user, ...(action ? { action } : {}) });
    };
    notification.on('click', () => click());
    notification.on('action', (_e, index) => click(n.actions[index]));
    const done = () => {
      this.shown.delete(notification);
      if (n.tag && this.live.get(n.tag) === notification) this.live.delete(n.tag);
    };
    notification.on('close', done);
    notification.on('failed', done);
    if (n.tag) this.live.get(n.tag)?.close();
    if (n.tag) this.live.set(n.tag, notification);
    this.shown.add(notification);
    notification.show();
  }
}

