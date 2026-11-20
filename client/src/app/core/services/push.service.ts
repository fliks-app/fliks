import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, computed, effect, inject, isDevMode, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { TranslateService } from '@ngx-translate/core';
import { firstValueFrom } from 'rxjs';
import { SKIP_ERROR_TOAST } from '../interceptors/error.interceptor';
import { desktopBridgeOrNull, type DesktopNotifyPrefs } from '../plugins/desktop-player.bridge';
import { Push, type PushOpened, type PushPermission, type SessionRef } from '../plugins/push.plugin';
import { readFlag, readStored, writeFlag, writeStored } from '../utils/local-flag';
import { sameOriginPath } from '../utils/same-origin';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { SERVER_SINCE, ServerVersionService } from './server-version.service';
import { SseService } from './sse.service';
import { ToastService } from './toast.service';

/** A user notification as the `notification` SSE event carries it (and the Web Push payload). */
export interface PushNotification {
  id: string;
  ts: number;
  ttl: number;
  cat: string;
  title: string;
  body: string;
  url: string;
  image?: string;
  actions?: PushAction[];
  badge?: number;
  tag?: string;
}

export interface PushAction {
  id: string;
  title: string;
  kind: 'open' | 'call';
  url?: string;
  token?: string;
}

/** `native`: APNs/FCM through the plugin; `web`: Web Push through the service worker; `desktop`: OS notifications from the Electron shell; `toast`: in-app only (TV); `none`: nothing on this device. */
export type PushMode = 'native' | 'web' | 'desktop' | 'toast' | 'none';

/** A plugin whose `plugin.<id>` category the user can mute. */
export interface PushPluginInfo {
  id: string;
  name: string;
}

interface PushConfig {
  mobile: boolean;
  vapidPublicKey: string;
  plugins?: PushPluginInfo[];
}

const PENDING_URL_KEY = 'fliks.push.pendingUrl';
const TOASTS_KEY = 'fliks.push.toasts';
/** A tap that switched server resumes only if the app comes back within this. */
const PENDING_URL_TTL_MS = 5 * 60_000;
/** Sign-out must not hang on an unreachable push service or server. */
const RELEASE_TIMEOUT_MS = 5000;
const LANG_MESSAGE = 'fliks-push-lang';

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

/** Subscribes this device to the server's notifications, shows them in-app and keeps the app badge. The native bridges plug in through `push.plugin.ts`. */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly sse = inject(SseService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);
  private readonly device = inject(DeviceService);
  private readonly router = inject(Router);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly version = inject(ServerVersionService);

  readonly mode: PushMode = this.detectMode();
  /** The server speaks the push API; an older one answers 404 on every route. */
  readonly serverSupported = computed(() => this.version.supports(SERVER_SINCE.push));
  /** Native push can be unavailable even in a mobile app (no Play services, no Firebase config). */
  readonly nativeAvailable = signal(false);
  readonly permission = signal<PushPermission>('prompt');
  /** The Fliks Relay connection is enabled; only mobile depends on it. */
  readonly mobileEnabled = signal(false);
  /** This account asked for system notifications on this device. */
  readonly deviceEnabled = signal(false);
  /** TV: show the in-app toasts. */
  readonly toastsEnabled = signal(readFlag(TOASTS_KEY, true));
  readonly busy = signal(false);
  /** Plugins that can notify this account, from `GET /api/push/config`. */
  readonly plugins = signal<PushPluginInfo[]>([]);
  /** Desktop: the window is visible and focused, so the in-app toast shows instead of an OS notification. */
  readonly desktopActive = signal(true);
  /** Desktop: background mode and start at login; null outside a shell that supports them. */
  readonly desktopPrefs = signal<DesktopNotifyPrefs | null>(null);
  /** A Web Push subscription is registered on the server for this session. */
  private readonly subscribed = signal(false);

  /** The device switch is offered here. */
  readonly canEnableDevice = computed(
    () => this.serverSupported() && (this.mode === 'web' || (this.mode === 'native' && this.nativeAvailable())),
  );
  /** Mobile whose admin has not switched the Fliks Relay connection on. */
  readonly mobileBlockedByAdmin = computed(() => this.mode === 'native' && this.nativeAvailable() && !this.mobileEnabled());
  /** Whether a system notification reaches this device, so the toast would repeat it. */
  private readonly systemCovers = computed(
    () => this.mode === 'web' && this.subscribed() && this.permission() === 'granted',
  );

  private openedHandle: PluginListenerHandle | null = null;
  /** A pending tap is honoured only by the launch that follows it, not by a later account switch. */
  private launched = false;

  constructor() {
    effect(() => {
      this.auth.sessionEpoch();
      const user = this.auth.user();
      untracked(() => {
        this.subscribed.set(false);
        if (!user || !this.serverSupported()) {
          this.deviceEnabled.set(false);
          return;
        }
        this.deviceEnabled.set(readFlag(this.flagKey(user.id), false));
        void this.start();
      });
    });
    this.sse.notifications.subscribe((n) => this.onNotification(n));
    effect(() => {
      if (this.mode !== 'web') return;
      const lang = this.translate.currentLang() || 'en';
      void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: LANG_MESSAGE, lang }));
    });
    // Registered with the service, which the app initializer creates: a tap on the user picker or the login page must not be lost.
    if (this.mode === 'web') {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type !== 'fliks-push-open') return;
        const user = typeof e.data.user === 'number' ? e.data.user : undefined;
        void this.opened({ url: String(e.data.url ?? '/'), session: user === undefined ? undefined : this.sessionRef(user) });
      });
    } else if (this.mode === 'native') {
      void this.listenNative();
    } else if (this.mode === 'desktop') {
      this.listenDesktop();
    }
  }

  setToastsEnabled(on: boolean): void {
    this.toastsEnabled.set(on);
    writeFlag(TOASTS_KEY, on);
  }

  /** Turns system notifications on for this device; call it from the user's click (the browser asks the permission there). */
  async enable(): Promise<boolean> {
    const user = this.auth.user();
    if (!user || !this.canEnableDevice()) return false;
    this.busy.set(true);
    try {
      if (this.mode === 'web') {
        const perm = await Notification.requestPermission();
        this.permission.set(perm === 'default' ? 'prompt' : perm);
        if (perm !== 'granted') return false;
      }
      await this.subscribe(false);
      writeStored(this.pendingDeleteKey(), null);
      writeFlag(this.flagKey(user.id), true);
      this.deviceEnabled.set(true);
      return true;
    } catch {
      this.toast.error(this.translate.instant('app_settings.notifications.enable_failed'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async disable(): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    this.busy.set(true);
    try {
      // The session is still valid: a failed server deletion stays pending and is retried at the next start.
      await this.unsubscribe(true).catch(() => undefined);
      writeFlag(this.flagKey(user.id), false);
      this.deviceEnabled.set(false);
    } finally {
      this.busy.set(false);
    }
  }

  /** Sign-out: drops this device's subscription but keeps the choice, so the same account signing in again resubscribes. The server sweeps the rows of a revoked session. */
  async release(): Promise<void> {
    if (!this.deviceEnabled()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, RELEASE_TIMEOUT_MS)));
    try {
      await Promise.race([this.unsubscribe(false).catch(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async setDesktopPref(patch: Partial<DesktopNotifyPrefs>): Promise<void> {
    const next = await desktopBridgeOrNull()?.setNotifyPrefs?.(patch);
    if (next) this.desktopPrefs.set(next);
  }

  async sendTest(): Promise<{ platform: string; ok: boolean; error?: string }[]> {
    const r = await firstValueFrom(
      this.http.post<{ results: { platform: string; ok: boolean; error?: string }[] }>('/api/push/test', {}),
    );
    return r.results;
  }

  /** The app badge follows the user's `attention` count. */
  setBadge(count: number): void {
    if (this.mode === 'native') {
      if (this.nativeAvailable()) void Push.setBadge({ count }).catch(() => undefined);
      return;
    }
    if (this.mode === 'desktop') {
      void desktopBridgeOrNull()?.setBadge?.(count)?.catch(() => undefined);
      return;
    }
    if (this.mode !== 'web') return;
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.())?.catch(() => undefined);
  }

  /** Runs a `call` action of a notification, then says how it went. */
  async runAction(a: PushAction): Promise<void> {
    if (a.kind === 'open') {
      void this.go(a.url);
      return;
    }
    try {
      await firstValueFrom(this.http.post('/api/push/act', { token: a.token }, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }));
      this.toast.success(this.translate.instant('app_settings.notifications.action_done'));
    } catch {
      this.toast.error(this.translate.instant('app_settings.notifications.action_failed'));
    }
  }

  /** A tapped notification: native fires it through the plugin, the browser through the service worker. */
  async opened(e: PushOpened): Promise<void> {
    const s = e.session;
    if (s && s.serverUrl !== this.serverConfig.serverUrl()) {
      writeStored(PENDING_URL_KEY, JSON.stringify({ url: e.url, userId: s.userId, exp: Date.now() + PENDING_URL_TTL_MS }));
      await this.auth.switchToServer(s.serverUrl);
      return;
    }
    if (s && s.userId !== this.auth.user()?.id && !(await this.resume(s.userId))) return;
    await this.go(e.url);
  }

  private async resume(userId: number): Promise<boolean> {
    return (await this.auth.resumeSession(userId)) === 'resumed';
  }

  private async go(url: string | undefined): Promise<void> {
    const path = sameOriginPath(url);
    if (path) await this.router.navigateByUrl(path);
  }

  private onNotification(n: PushNotification): void {
    if (n.badge !== undefined) this.setBadge(n.badge);
    if (this.systemCovers()) return;
    if (this.device.isTv() && !this.toastsEnabled()) return;
    const user = this.auth.user();
    const bridge = desktopBridgeOrNull();
    if (this.mode === 'desktop' && !this.desktopActive() && this.desktopPrefs()?.notifications && user && bridge?.notify) {
      void bridge
        .notify({
          id: n.id,
          title: n.title,
          body: n.body,
          image: n.image,
          tag: n.tag,
          url: n.url,
          serverUrl: this.serverConfig.serverUrl(),
          user: user.id,
          actions: n.actions ?? [],
        })
        .catch(() => undefined);
      return;
    }
    const tv = this.device.isTv();
    this.toast.notify({
      title: n.title,
      body: n.body,
      image: n.image ? this.serverConfig.resolveUrl(n.image) : undefined,
      tag: n.tag,
      tv,
      actions: (n.actions ?? []).map((a) => ({ label: a.title, run: () => void this.runAction(a) })),
    });
  }

  private async start(): Promise<void> {
    if (!this.launched) {
      this.launched = true;
      await this.consumePendingUrl();
    }
    await this.retryPendingDelete();
    if (this.mode === 'native') await this.startNative();
    if (this.mode === 'desktop') this.desktopPrefs.set((await desktopBridgeOrNull()?.getNotifyPrefs?.()) ?? null);
    if (this.mode === 'web') this.permission.set(this.webPermission());
    if (this.mode === 'native' || this.mode === 'web') await this.loadConfig();
    if (this.deviceEnabled() && this.canEnableDevice()) {
      // Background resubscribe at login, launch and session switch: a refusal is not the user's to see.
      await this.subscribe(true).catch(() => this.subscribed.set(false));
    }
  }

  private async consumePendingUrl(): Promise<void> {
    const raw = readStored(PENDING_URL_KEY);
    if (!raw) return;
    writeStored(PENDING_URL_KEY, null);
    let pending: { url?: string; userId?: number; exp?: number };
    try {
      pending = JSON.parse(raw);
    } catch {
      return;
    }
    if (!pending.exp || pending.exp < Date.now()) return;
    if (pending.userId !== undefined && pending.userId !== this.auth.user()?.id && !(await this.resume(pending.userId))) {
      this.toast.error(this.translate.instant('app_settings.notifications.pending_expired'));
      return;
    }
    await this.go(pending.url);
  }

  private async listenNative(): Promise<void> {
    try {
      this.openedHandle ??= await Push.addListener('pushOpened', (e) => void this.opened(e));
    } catch {
      // no plugin in this build: nothing taps a notification
    }
  }

  private listenDesktop(): void {
    const bridge = desktopBridgeOrNull();
    bridge?.onNotificationClick?.((e) => {
      if (e.action?.kind === 'call') void this.runAction(e.action);
      else void this.opened({ url: e.action?.url ?? e.url, session: { serverUrl: e.serverUrl, userId: e.user, key: `${e.serverUrl}|${e.user}` } });
    });
    void bridge?.windowActive?.().then((a) => this.desktopActive.set(a));
    bridge?.onWindowActive?.((a) => this.desktopActive.set(a));
  }

  private async startNative(): Promise<void> {
    try {
      const st = await Push.status();
      this.nativeAvailable.set(st.available);
      this.permission.set(st.permission);
    } catch {
      this.nativeAvailable.set(false);
    }
  }

  async loadConfig(): Promise<PushConfig | null> {
    try {
      const cfg = await firstValueFrom(
        this.http.get<PushConfig>('/api/push/config', { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }),
      );
      this.mobileEnabled.set(cfg.mobile);
      this.plugins.set((cfg.plugins ?? []).map((p) => ({ id: p.id, name: p.name || p.id })));
      return cfg;
    } catch {
      return null;
    }
  }

  private async subscribe(quiet: boolean): Promise<void> {
    const ctx = quiet ? new HttpContext().set(SKIP_ERROR_TOAST, true) : undefined;
    const locale = this.translate.currentLang() || 'en';
    if (this.mode === 'native') {
      if (!this.mobileEnabled()) await this.loadConfig();
      if (!this.mobileEnabled()) {
        if (quiet) return;
        throw new Error('push disabled by the admin');
      }
      const ref = this.sessionRef();
      const p = await Push.prepare({ session: ref.key });
      const r = await firstValueFrom(this.http.post<{ sub: string; ticket: string }>('/api/push/subscriptions', { ...p, locale }, { context: ctx }));
      await Push.subscribe({ session: ref.key, sub: r.sub, ticket: r.ticket, serverUrl: ref.serverUrl });
      return;
    }
    this.subscribed.set(false);
    const cfg = (await this.loadConfig()) ?? undefined;
    if (!cfg?.vapidPublicKey) throw new Error('no VAPID key');
    const reg = await navigator.serviceWorker.ready;
    const key = b64urlToBytes(cfg.vapidPublicKey);
    let sub = await reg.pushManager.getSubscription();
    // A server that changed its VAPID identity invalidates the subscription.
    if (sub && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    await firstValueFrom(
      this.http.post(
        '/api/push/subscriptions',
        { platform: 'web', endpoint: json.endpoint, p256dh: json.keys?.['p256dh'], auth: json.keys?.['auth'], locale },
        { context: ctx },
      ),
    );
    this.subscribed.set(true);
  }

  /** Both sides always run, so a failed server deletion never keeps the browser or the plugin subscribed; with `retry` it stays pending until the next start. */
  private async unsubscribe(retry: boolean): Promise<void> {
    this.subscribed.set(false);
    const native = this.mode === 'native';
    const platform = native ? (Capacitor.getPlatform() === 'ios' ? 'apns' : 'fcm') : 'web';
    const key = this.pendingDeleteKey();
    if (retry) writeStored(key, platform);
    const local = native ? Push.unsubscribe({ session: this.sessionRef().key }) : this.unsubscribeWeb();
    const remote = this.deleteCurrent(platform).then(() => writeStored(key, null));
    const failed = (await Promise.allSettled([local, remote])).find((r) => r.status === 'rejected');
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  private async unsubscribeWeb(): Promise<void> {
    const reg = await navigator.serviceWorker.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  }

  private async retryPendingDelete(): Promise<void> {
    const platform = readStored(this.pendingDeleteKey());
    if (!platform) return;
    await this.deleteCurrent(platform).then(() => writeStored(this.pendingDeleteKey(), null)).catch(() => undefined);
  }

  private deleteCurrent(platform: string): Promise<unknown> {
    return firstValueFrom(
      this.http.delete('/api/push/subscriptions/current', { body: { platform }, context: new HttpContext().set(SKIP_ERROR_TOAST, true) }),
    );
  }

  private sessionRef(userId = this.auth.user()?.id ?? 0): SessionRef {
    const serverUrl = this.serverConfig.serverUrl();
    return { serverUrl, userId, key: `${serverUrl}|${userId}` };
  }

  private pendingDeleteKey(): string {
    return `fliks.push.pendingDelete::${this.serverConfig.serverUrl()}::${this.auth.user()?.id ?? 0}`;
  }

  private flagKey(userId: number): string {
    return `fliks.push.device::${this.serverConfig.serverUrl()}::${userId}`;
  }

  private webPermission(): PushPermission {
    return Notification.permission === 'default' ? 'prompt' : Notification.permission;
  }

  private detectMode(): PushMode {
    if (this.device.isTv()) return 'toast';
    if (Capacitor.isNativePlatform()) return 'native';
    if (this.device.isDesktopNative()) return desktopBridgeOrNull()?.notify ? 'desktop' : 'none';
    const web =
      !isDevMode() &&
      globalThis.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in globalThis &&
      'Notification' in globalThis;
    return web && this.iosAllowsWebPush() ? 'web' : 'none';
  }

  /** Safari on iOS delivers Web Push to the web app added to the home screen only. */
  private iosAllowsWebPush(): boolean {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return !ios || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  }
}
