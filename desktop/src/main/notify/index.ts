import { app, ipcMain, Menu, nativeImage, net, Notification, Tray } from 'electron';
import { NOTIFY_IPC } from '../../shared/contract.ts';
import type { DesktopNotification, DesktopNotificationAction, DesktopNotifyLabels, DesktopNotifyPrefs } from '../../shared/contract.ts';
import { setStartAtLogin, startedAtLogin } from './autostart.ts';
import { saneSize, readCapped } from './image.ts';
import { hasStatusNotifierHost } from './status-notifier.ts';
import { loadLabels, loadPrefs, saveLabels, savePrefs } from './prefs.ts';
import { notifyStatus, openNotifySettings } from './status.ts';
import { parseBadge, parseLabels, parseNotification, parsePrefsPatch } from './validate.ts';

/** What the notifier needs from the platform's window code; handed over once the window exists. */
export interface NotifyHost {
  show(): void;
  hide(): void;
  /** Windows: the taskbar overlay; null clears it. */
  setOverlay?(icon: Electron.NativeImage | null, description: string): void;
  sendToPage(channel: string, payload: unknown): void;
}

const IMAGE_TIMEOUT_MS = 4000;
const MAX_LIVE = 50;

/** A public route: no cookies, no redirect. A failure to fetch is a notification without a picture. */
async function fetchImage(path: string, serverUrl: string): Promise<Electron.NativeImage | undefined> {
  try {
    const res = await net.fetch(new URL(path, serverUrl).href, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const buf = await readCapped(res);
    const img = buf && nativeImage.createFromBuffer(buf);
    return img && !img.isEmpty() && saneSize(img.getSize()) ? img : undefined;
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

/** Shown until the page has sent its translated labels. */
const FALLBACK_LABELS: DesktopNotifyLabels = { open: 'Fliks', quit: 'Quit', notifications: 'Notifications' };

export class Notifier {
  private host: NotifyHost | null = null;
  private prefs = loadPrefs();
  private labels = loadLabels() ?? FALLBACK_LABELS;
  private tray: Tray | null = null;
  private active = true;
  private quitting = false;
  private readonly live = new Map<string, Electron.Notification>();
  private readonly shown = new Set<Electron.Notification>();

  private readonly trayIcon: string | undefined;
  private readonly hasTrayHost: () => Promise<boolean>;

  constructor(trayIcon: string | undefined, hasTrayHost: () => Promise<boolean> = hasStatusNotifierHost) {
    this.trayIcon = trayIcon;
    this.hasTrayHost = hasTrayHost;
    app.on('before-quit', () => (this.quitting = true));
    app.on('activate', () => this.show());
    app.on('second-instance', () => this.show());
    ipcMain.handle(NOTIFY_IPC.show, (_e, n: unknown) => this.notify(parseNotification(n)));
    ipcMain.handle(NOTIFY_IPC.setBadge, (_e, count: unknown) => this.setBadge(parseBadge(count)));
    ipcMain.handle(NOTIFY_IPC.getPrefs, () => this.prefs);
    ipcMain.handle(NOTIFY_IPC.setPrefs, (_e, patch: unknown) => this.setPrefs(parsePrefsPatch(patch)));
    ipcMain.handle(NOTIFY_IPC.setLabels, (_e, l: unknown) => this.setLabels(parseLabels(l)));
    ipcMain.handle(NOTIFY_IPC.windowActive, () => this.active);
    ipcMain.handle(NOTIFY_IPC.getStatus, () => notifyStatus());
    ipcMain.handle(NOTIFY_IPC.openSettings, () => openNotifySettings());
  }

  /** Closing the window hides it instead of quitting, but only with a tray to come back from. */
  hideOnClose(): boolean {
    return this.prefs.background && this.tray !== null && !this.quitting;
  }

  /** The close button of a platform whose window the shell cannot veto itself. */
  requestClose(): void {
    if (this.hideOnClose()) this.host?.hide();
    else app.quit();
  }

  show(): void {
    this.host?.show();
  }

  async attach(host: NotifyHost): Promise<void> {
    this.host = host;
    await this.syncTray();
    if (this.prefs.background && !this.tray) await this.save({ background: false });
    if (this.prefs.startAtLogin) this.persistLogin(true);
    if (this.hideOnClose() && startedAtLogin()) host.hide();
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    this.host?.sendToPage(NOTIFY_IPC.active, active);
  }

  private save(patch: Partial<DesktopNotifyPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    savePrefs(this.prefs);
  }

  private persistLogin(on: boolean): void {
    const actual = setStartAtLogin(on);
    if (actual !== on) console.error('[notify] start at login did not stick');
    if (actual !== this.prefs.startAtLogin) this.save({ startAtLogin: actual });
  }

  private async setPrefs(patch: Partial<DesktopNotifyPrefs>): Promise<DesktopNotifyPrefs> {
    const { background, startAtLogin, ...rest } = patch;
    this.save(rest);
    if (background !== undefined) {
      this.save({ background });
      await this.syncTray();
      if (background && !this.tray) this.save({ background: false });
      if (!this.prefs.background) this.show();
    }
    if (startAtLogin !== undefined) this.persistLogin(startAtLogin);
    return this.prefs;
  }

  private setLabels(labels: DesktopNotifyLabels): void {
    this.labels = labels;
    saveLabels(labels);
    this.tray?.setContextMenu(this.menu());
  }

  private menu(): Electron.Menu {
    return Menu.buildFromTemplate([
      { label: this.labels.open, click: () => this.show() },
      { label: this.labels.quit, click: () => app.quit() },
    ]);
  }

  private async syncTray(): Promise<void> {
    if (!this.prefs.background) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (this.tray || !this.trayIcon || !(await this.hasTrayHost())) return;
    const size = process.platform === 'darwin' ? 18 : 32;
    this.tray = new Tray(nativeImage.createFromPath(this.trayIcon).resize({ width: size, height: size }));
    this.tray.setToolTip(app.getName());
    this.tray.setContextMenu(this.menu());
    this.tray.on('click', () => this.show());
  }

  private setBadge(count: number): void {
    if (process.platform === 'win32') this.host?.setOverlay?.(count > 0 ? dotIcon() : null, this.labels.notifications);
    else app.setBadgeCount(count);
  }

  private async notify(n: DesktopNotification): Promise<void> {
    if (!Notification.isSupported()) return;
    const icon = n.image ? await fetchImage(n.image, n.serverUrl) : undefined;
    const notification = new Notification({
      title: n.title,
      body: n.body,
      ...(icon ? { icon } : {}),
      actions: n.actions.map((a) => ({ type: 'button' as const, text: a.title })),
    });
    const click = (action?: DesktopNotificationAction) => {
      this.show();
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
    // A platform that never reports the close would grow this set: the oldest are let go.
    if (this.shown.size >= MAX_LIVE) this.shown.delete(this.shown.values().next().value!);
    this.shown.add(notification);
    notification.show();
  }
}
