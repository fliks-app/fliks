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
import { ConfirmationService } from './confirmation.service';
import { DeviceService } from './device.service';
import { ServerConfigService } from './server-config.service';
import { SessionStoreService } from './session-store.service';
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

/** A moment where a notification is clearly useful: the pre-prompt says why. */
export type PushReason = 'request' | 'party' | 'download';

export interface AskState {
  mode: PushMode;
  reason: PushReason;
  /** Push can be switched on here: server, platform and admin allow it. */
  pushReady: boolean;
  permission: PushPermission;
  deviceEnabled: boolean;
  /** The user turned this device off in the settings. */
  deviceOff: boolean;
  snooze: AskSnooze;
  now: number;
}

export interface AskSnooze {
  declined: number;
  until: number;
}

/** After this many "Not now" only the settings page turns notifications on. */
const MAX_DECLINES = 3;
const SNOOZE_MS = 14 * 24 * 3600_000;

/** Whether to show the pre-prompt; a denied permission is left to the settings page. */
export function shouldAsk(s: AskState): boolean {
  if (s.mode !== 'native' && s.mode !== 'web') return false;
  if (s.permission === 'denied' || s.snooze.declined >= MAX_DECLINES || s.now < s.snooze.until) return false;
  // A download only needs the permission: its banner is local.
  if (s.reason === 'download') return s.mode === 'native' && s.permission !== 'granted';
  return s.pushReady && !s.deviceOff && !(s.deviceEnabled && s.permission === 'granted');
}

const PENDING_URL_KEY = 'fliks.push.pendingUrl';
const TOASTS_KEY = 'fliks.push.toasts';
/** Per device, like the OS permission it guards. */
const SNOOZE_KEY = 'fliks.push.askSnooze';
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
  private readonly sessions = inject(SessionStoreService);
  private readonly serverConfig = inject(ServerConfigService);
  private readonly version = inject(ServerVersionService);
  private readonly confirm = inject(ConfirmationService);

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
  private asking = false;

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
    effect(() => {
      if (this.mode !== 'desktop') return;
      this.translate.currentLang();
      const keys = ['tray_open', 'tray_quit', 'badge_label'].map((k) => `app_settings.notifications.${k}`);
      void firstValueFrom(this.translate.get(keys)).then((t) =>
        desktopBridgeOrNull()?.setNotifyLabels?.({ open: t[keys[0]], quit: t[keys[1]], notifications: t[keys[2]] }),
      );
    });
    this.sse.notifications.subscribe((n) => this.onNotification(n));
    effect(() => {
      if (this.mode !== 'web') return;
      const lang = this.translate.currentLang() || 'en';
      void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: LANG_MESSAGE, lang }));
    });
    // The user may have changed the permission in the system settings meanwhile.
    if (this.mode === 'native' || this.mode === 'web') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.refreshPermission();
      });
    }
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
      if ((await this.requestPermission()) !== 'granted') return false;
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

  /** Offers notifications at a moment where they help; snoozed after "Not now", silent once the system denied them. */
  async askInContext(reason: PushReason): Promise<void> {
    if (this.asking) return;
    const user = this.auth.user();
    const stored = user ? readStored(this.flagKey(user.id)) : null;
    const snooze = this.readSnooze();
    const state: AskState = {
      mode: this.mode,
      reason,
      pushReady: this.canEnableDevice() && !this.mobileBlockedByAdmin(),
      permission: this.permission(),
      deviceEnabled: this.deviceEnabled(),
      deviceOff: stored === '0',
      snooze,
      now: Date.now(),
    };
    if (!user || !shouldAsk(state)) return;
    this.asking = true;
    try {
      const key = `app_settings.notifications.ask_${reason}`;
      const yes = await this.confirm.confirm({
        title: this.translate.instant(`${key}_title`),
        message: this.translate.instant(`${key}_body`),
        confirmLabel: this.translate.instant('app_settings.notifications.ask_enable'),
        cancelLabel: this.translate.instant('app_settings.notifications.ask_later'),
        variant: 'info',
      });
      const ok = yes && (state.pushReady && !state.deviceOff ? await this.enable() : (await this.requestPermission().catch(() => 'prompt')) === 'granted');
      if (ok) this.adoptGrant();
      if (!ok) writeStored(SNOOZE_KEY, JSON.stringify({ declined: snooze.declined + 1, until: Date.now() + SNOOZE_MS }));
    } finally {
      this.asking = false;
    }
  }

  /** Native only: the system page where a refused permission is given back. */
  openSystemSettings(): void {
    void Push.openSettings().catch(() => undefined);
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
    // A cold-start tap can arrive before the app initializer has read the stored sessions.
    await this.sessions.load();
    const s = e.session;
    if (s && s.serverUrl !== this.serverConfig.serverUrl()) {
      writeStored(PENDING_URL_KEY, JSON.stringify({ url: e.url, userId: s.userId, exp: Date.now() + PENDING_URL_TTL_MS }));
      await this.auth.switchToServer(s.serverUrl);
      return;
    }
    // The route guard sets the user after this on a cold start; the stored session is already active.
    const current = this.auth.user()?.id ?? this.auth.loadPersistedSession()?.id;
    if (s && s.userId !== current && !(await this.resume(s.userId))) return;
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
    this.adoptGrant();
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

  private async requestPermission(): Promise<PushPermission> {
    const perm =
      this.mode === 'web'
        ? await Notification.requestPermission().then((p) => (p === 'default' ? 'prompt' : p))
        : (await Push.requestPermission()).permission;
    this.permission.set(perm);
    return perm;
  }

  private async refreshPermission(): Promise<void> {
    if (this.mode === 'web') this.permission.set(this.webPermission());
    else await this.startNative();
    if (this.adoptGrant()) await this.subscribe(true).catch(() => this.subscribed.set(false));
  }

  /** Native: a granted permission turns this device on, unless this account switched it off here. */
  private adoptGrant(): boolean {
    const user = this.auth.user();
    if (this.mode !== 'native' || !user || this.deviceEnabled() || this.permission() !== 'granted' || !this.canEnableDevice()) return false;
    if (readStored(this.flagKey(user.id)) !== null) return false;
    writeFlag(this.flagKey(user.id), true);
    this.deviceEnabled.set(true);
    return true;
  }

  private readSnooze(): AskSnooze {
    try {
      const s = JSON.parse(readStored(SNOOZE_KEY) ?? '{}') as Partial<AskSnooze>;
      return { declined: s.declined ?? 0, until: s.until ?? 0 };
    } catch {
      return { declined: 0, until: 0 };
    }
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
