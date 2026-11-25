import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { ConfirmationService } from './confirmation.service';
import { DeviceService } from './device.service';
import { type AskState, PushService, shouldAsk } from './push.service';
import { ServerConfigService } from './server-config.service';
import { ServerVersionService } from './server-version.service';
import { SessionStoreService } from './session-store.service';
import { SseService } from './sse.service';
import { ToastService } from './toast.service';

const PENDING = 'fliks.push.pendingUrl';
const SNOOZE = 'fliks.push.askSnooze';

const { plugin, platform } = vi.hoisted(() => ({
  plugin: { status: vi.fn(), requestPermission: vi.fn(), prepare: vi.fn(), subscribe: vi.fn(), addListener: vi.fn() },
  platform: { native: false },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => platform.native,
    getPlatform: () => (platform.native ? 'android' : 'web'),
    isPluginAvailable: () => false,
    convertFileSrc: (s: string) => s,
  },
  registerPlugin: () => plugin,
}));

describe('PushService', () => {
  const user = signal<{ id: number } | null>({ id: 1 });
  const resumeSession = vi.fn();
  const switchToServer = vi.fn();
  const navigateByUrl = vi.fn();
  const toastError = vi.fn();
  const loadPersistedSession = vi.fn();
  const sessionsLoad = vi.fn();
  const confirm = vi.fn();
  const toastNotify = vi.fn();
  let sseNotifications = new Subject<unknown>();
  let tv = false;
  let desktop = false;

  function create(): { push: PushService; http: HttpTestingController } {
    sseNotifications = new Subject<unknown>();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user, sessionEpoch: signal(0), resumeSession, switchToServer, loadPersistedSession } },
        { provide: SessionStoreService, useValue: { load: sessionsLoad } },
        { provide: SseService, useValue: { notifications: sseNotifications } },
        { provide: ToastService, useValue: { error: toastError, notify: toastNotify } },
        { provide: TranslateService, useValue: { instant: (k: string) => k, currentLang: () => 'en', get: () => of({}) } },
        { provide: DeviceService, useValue: { isTv: () => tv, isDesktopNative: () => desktop } },
        { provide: ConfirmationService, useValue: { confirm } },
        { provide: Router, useValue: { navigateByUrl } },
        { provide: ServerConfigService, useValue: { serverUrl: () => 'https://a.test', resolveUrl: (u: string) => u } },
        { provide: ServerVersionService, useValue: { supports: () => true } },
      ],
    });
    const push = TestBed.inject(PushService);
    TestBed.tick();
    return { push, http: TestBed.inject(HttpTestingController) };
  }

  beforeEach(() => {
    localStorage.clear();
    user.set({ id: 1 });
    vi.clearAllMocks();
    resumeSession.mockResolvedValue('resumed');
    loadPersistedSession.mockReturnValue(null);
    sessionsLoad.mockResolvedValue(undefined);
    tv = false;
    desktop = false;
  });

  describe('opened', () => {
    it('navigates inside the current session', async () => {
      const { push } = create();
      await push.opened({ url: '/requests', session: { serverUrl: 'https://a.test', userId: 1, key: 'k' } });
      expect(navigateByUrl).toHaveBeenCalledWith('/requests');
      expect(resumeSession).not.toHaveBeenCalled();
    });

    it('takes the stored session as current on a cold start, before the guard sets the user', async () => {
      const { push } = create();
      user.set(null);
      sessionsLoad.mockImplementation(async () => void loadPersistedSession.mockReturnValue({ id: 2 }));
      await push.opened({ url: '/requests', session: { serverUrl: 'https://a.test', userId: 2, key: 'k' } });
      expect(resumeSession).not.toHaveBeenCalled();
      expect(navigateByUrl).toHaveBeenCalledWith('/requests');
    });

    it('resumes the recipient first, and stops when that fails', async () => {
      const { push } = create();
      const session = { serverUrl: 'https://a.test', userId: 2, key: 'k' };
      await push.opened({ url: '/x', session });
      expect(resumeSession).toHaveBeenCalledWith(2);
      expect(navigateByUrl).toHaveBeenCalledWith('/x');
      navigateByUrl.mockClear();
      resumeSession.mockResolvedValue('expired');
      await push.opened({ url: '/x', session });
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('stashes the tap with its user when the server differs', async () => {
      const { push } = create();
      await push.opened({ url: '/x', session: { serverUrl: 'https://b.test', userId: 5, key: 'k' } });
      expect(switchToServer).toHaveBeenCalledWith('https://b.test');
      expect(JSON.parse(localStorage.getItem(PENDING) ?? '{}')).toMatchObject({ url: '/x', userId: 5 });
    });

    it('ignores a url of another origin', async () => {
      const { push } = create();
      await push.opened({ url: '//evil.test/x' });
      expect(navigateByUrl).not.toHaveBeenCalled();
    });
  });

  describe('pending tap at launch', () => {
    const stash = (userId: number, exp = Date.now() + 60_000) => localStorage.setItem(PENDING, JSON.stringify({ url: '/p', userId, exp }));

    it('resumes the tapped user, then navigates', async () => {
      stash(2);
      create();
      await vi.waitFor(() => expect(navigateByUrl).toHaveBeenCalledWith('/p'));
      expect(resumeSession).toHaveBeenCalledWith(2);
      expect(localStorage.getItem(PENDING)).toBeNull();
    });

    it('tells the user when the session is gone', async () => {
      stash(2);
      resumeSession.mockResolvedValue('expired');
      create();
      await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('drops an expired entry', async () => {
      stash(2, Date.now() - 1);
      create();
      await vi.waitFor(() => expect(localStorage.getItem(PENDING)).toBeNull());
      expect(resumeSession).not.toHaveBeenCalled();
      expect(navigateByUrl).not.toHaveBeenCalled();
    });
  });

  it('retries a pending server deletion at the next start', async () => {
    localStorage.setItem('fliks.push.pendingDelete::https://a.test::1', 'fcm');
    const { http } = create();
    await vi.waitFor(() => http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/push/subscriptions/current').flush(null));
    await vi.waitFor(() => expect(localStorage.getItem('fliks.push.pendingDelete::https://a.test::1')).toBeNull());
  });

  describe('desktop', () => {
    const notify = vi.fn();
    const prefs = { notifications: true, background: false, startAtLogin: false };
    let status = 'allowed';
    let onActive: (a: boolean) => void = () => undefined;
    const win = window as unknown as { fliksDesktop?: unknown };

    beforeEach(() => {
      desktop = true;
      prefs.notifications = true;
      status = 'allowed';
      notify.mockResolvedValue(undefined);
      win.fliksDesktop = {
        notify,
        getNotifyPrefs: async () => ({ ...prefs }),
        windowActive: async () => true,
        onWindowActive: (h: (a: boolean) => void) => (onActive = h),
        getNotifyStatus: async () => status,
        openNotifySettings: vi.fn(async () => undefined),
        onNotificationClick: () => undefined,
      };
    });
    afterEach(() => delete win.fliksDesktop);

    async function started(): Promise<{ push: PushService; http: HttpTestingController }> {
      const r = create();
      await vi.waitFor(() => expect(r.push.desktopStatus()).not.toBeNull());
      return r;
    }
    const note = (tag?: string, v = 1) => ({ v, id: 'n', ts: 0, ttl: 60, cat: 'account', title: 't', body: 'b', url: '/', tag });

    it('offers the home banner until notifications reach a closed window, and turns both on', async () => {
      const setNotifyPrefs = vi.fn(async (p: object) => ({ ...prefs, ...p }));
      Object.assign(win.fliksDesktop as object, { setNotifyPrefs });
      const { push } = await started();
      await vi.waitFor(() => expect(push.offerBanner()).toBe(true));
      await push.acceptBanner();
      expect(setNotifyPrefs).toHaveBeenCalledWith({ notifications: true, background: true });
      expect(push.offerBanner()).toBe(false);
    });

    it('shows the test notification through the OS even with the window in front', async () => {
      await started();
      sseNotifications.next(note('test'));
      expect(notify).toHaveBeenCalledOnce();
      expect(toastNotify).not.toHaveBeenCalled();
      sseNotifications.next(note());
      expect(notify).toHaveBeenCalledOnce();
      expect(toastNotify).toHaveBeenCalledOnce();
    });

    it('shows the generic text, nothing of the payload, for a higher plaintext version', async () => {
      await started();
      sseNotifications.next({ ...note('x', 2), badge: 5, image: '/i', actions: [{ id: 'a', title: 'A', kind: 'open' }] });
      expect(toastNotify).toHaveBeenCalledOnce();
      expect(toastNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'app_settings.notifications.unreadable_title',
          body: 'app_settings.notifications.unreadable_body',
          tag: undefined,
          image: undefined,
          actions: [],
        }),
      );
    });

    it('reads the OS block, again when the window comes back, and opens its settings', async () => {
      status = 'blocked';
      const { push } = await started();
      await vi.waitFor(() => expect(push.systemBlock()).toBe('denied_app'));
      expect(push.canOpenSystemSettings()).toBe(true);
      push.openSystemSettings();
      expect((win.fliksDesktop as { openNotifySettings: ReturnType<typeof vi.fn> }).openNotifySettings).toHaveBeenCalledOnce();
      status = 'allowed';
      onActive(true);
      await vi.waitFor(() => expect(push.systemBlock()).toBeNull());
    });

    it('says when the system has no notification service, with no settings to open', async () => {
      status = 'unavailable';
      const { push } = await started();
      await vi.waitFor(() => expect(push.systemBlock()).toBe('unavailable'));
      expect(push.canOpenSystemSettings()).toBe(false);
    });

    it('falls back to the in-app toast while the OS blocks Fliks, and leaves this desktop out of the test', async () => {
      status = 'blocked';
      const { push, http } = await started();
      await vi.waitFor(() => expect(push.systemBlock()).toBe('denied_app'));
      expect(push.desktopShows()).toBe(false);
      sseNotifications.next(note('test'));
      expect(notify).not.toHaveBeenCalled();
      expect(toastNotify).toHaveBeenCalledOnce();
      const sent = push.sendTest();
      http.expectOne('/api/push/test').flush({ results: [] });
      expect(await sent).toEqual([]);
    });

    it('counts this desktop among the devices the test reaches while its notifications are on', async () => {
      const { push, http } = await started();
      const sent = push.sendTest();
      http.expectOne('/api/push/test').flush({ results: [] });
      expect(await sent).toEqual([{ platform: 'desktop', ok: true }]);
      push.desktopPrefs.set({ ...prefs, notifications: false });
      const none = push.sendTest();
      http.expectOne('/api/push/test').flush({ results: [] });
      expect(await none).toEqual([]);
    });
  });

  describe('askInContext', () => {
    beforeEach(() => {
      platform.native = true;
      plugin.status.mockResolvedValue({ available: true, permission: 'prompt' });
      plugin.addListener.mockResolvedValue({ remove: async () => undefined });
      plugin.prepare.mockResolvedValue({ platform: 'fcm', p256dh: 'k', auth: 'a' });
      plugin.subscribe.mockResolvedValue(undefined);
    });
    afterEach(() => (platform.native = false));
    /** The pre-prompt's Turn on: runs the confirm hook inside the click, as the dialog does. */
    const turnOn = async (o: { onConfirm?: () => void }) => (o.onConfirm?.(), true);

    async function started(mobile = true): Promise<{ push: PushService; http: HttpTestingController }> {
      const r = create();
      await vi.waitFor(() => r.http.expectOne('/api/push/config').flush({ mobile, vapidPublicKey: '' }));
      await vi.waitFor(() => expect(r.push.mobileEnabled()).toBe(mobile));
      return r;
    }

    it('offers the home banner on a phone not yet on, and keeps it hidden once hidden', async () => {
      const { push } = await started();
      expect(push.offerBanner()).toBe(true);
      push.hideBanner();
      expect(push.offerBanner()).toBe(false);
      TestBed.resetTestingModule();
      expect((await started()).push.offerBanner()).toBe(false);
    });

    it('turns push on after the pre-prompt and the system dialog', async () => {
      confirm.mockImplementation(turnOn);
      plugin.requestPermission.mockResolvedValue({ permission: 'granted' });
      const { push, http } = await started();
      const asked = push.askInContext('request');
      await vi.waitFor(() => http.expectOne((r) => r.method === 'POST' && r.url === '/api/push/subscriptions').flush({ sub: 's', ticket: 't' }));
      await asked;
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'app_settings.notifications.ask_request_title' }));
      expect(push.deviceEnabled()).toBe(true);
      expect(localStorage.getItem(SNOOZE)).toBeNull();
      await push.askInContext('party');
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('does not count a subscription that failed after the permission as a refusal', async () => {
      confirm.mockImplementation(turnOn);
      plugin.requestPermission.mockResolvedValue({ permission: 'granted' });
      const { push, http } = await started();
      const asked = push.askInContext('request');
      await vi.waitFor(() =>
        http.expectOne((r) => r.method === 'POST' && r.url === '/api/push/subscriptions').flush(null, { status: 503, statusText: 'Unavailable' }),
      );
      await asked;
      expect(localStorage.getItem(SNOOZE)).toBeNull();
      expect(toastError).toHaveBeenCalledWith('app_settings.notifications.enable_failed');
      expect(localStorage.getItem('fliks.push.device::https://a.test::1')).toBe('1');
    });

    it('asks the system inside the Turn on click, not after it', async () => {
      let hook: (() => void) | undefined;
      confirm.mockImplementation(async (o: { onConfirm?: () => void }) => ((hook = o.onConfirm), true));
      plugin.requestPermission.mockResolvedValue({ permission: 'denied' });
      const { push } = await started();
      await push.askInContext('request');
      expect(hook).toBeTypeOf('function');
      expect(plugin.requestPermission).not.toHaveBeenCalled();
    });

    it('snoozes after Not now without touching the system dialog', async () => {
      confirm.mockResolvedValue(false);
      const { push } = await started();
      await push.askInContext('request');
      await push.askInContext('party');
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(plugin.requestPermission).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(SNOOZE)!).declined).toBe(1);
    });

    it('leaves a refusal at the system dialog to the settings page', async () => {
      confirm.mockImplementation(turnOn);
      plugin.requestPermission.mockResolvedValue({ permission: 'denied' });
      const { push } = await started();
      await push.askInContext('request');
      expect(push.permission()).toBe('denied');
      expect(push.deviceEnabled()).toBe(false);
      expect(plugin.prepare).not.toHaveBeenCalled();
    });

    it('asks only the permission for a download when the admin keeps push off', async () => {
      confirm.mockImplementation(turnOn);
      plugin.requestPermission.mockResolvedValue({ permission: 'granted' });
      const { push } = await started(false);
      await push.askInContext('request');
      expect(confirm).not.toHaveBeenCalled();
      await push.askInContext('download');
      expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
      expect(plugin.prepare).not.toHaveBeenCalled();
    });

    it('shows one pre-prompt for a batch of downloads', async () => {
      let answer!: (v: boolean) => void;
      confirm.mockReturnValue(new Promise<boolean>((r) => (answer = r)));
      const { push } = await started(false);
      const first = push.askInContext('download');
      await push.askInContext('download');
      answer(false);
      await first;
      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('turns the device on at launch when the permission is already granted', async () => {
      plugin.status.mockResolvedValue({ available: true, permission: 'granted' });
      const { push, http } = await started();
      await vi.waitFor(() => http.expectOne((r) => r.method === 'POST' && r.url === '/api/push/subscriptions').flush({ sub: 's', ticket: 't' }));
      expect(push.deviceEnabled()).toBe(true);
      expect(localStorage.getItem('fliks.push.device::https://a.test::1')).toBe('1');
    });

    it('keeps the device off when the user switched it off, permission or not', async () => {
      plugin.status.mockResolvedValue({ available: true, permission: 'granted' });
      localStorage.setItem('fliks.push.device::https://a.test::1', '0');
      const { push, http } = await started();
      await new Promise((r) => setTimeout(r));
      http.expectNone((r) => r.method === 'POST');
      expect(push.deviceEnabled()).toBe(false);
    });

    it('subscribes again when the permission comes back from the system settings', async () => {
      plugin.status.mockResolvedValue({ available: true, permission: 'denied' });
      localStorage.setItem('fliks.push.device::https://a.test::1', '1');
      const { push, http } = await started();
      expect(push.permission()).toBe('denied');
      plugin.status.mockResolvedValue({ available: true, permission: 'granted' });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() => http.expectOne((r) => r.method === 'POST' && r.url === '/api/push/subscriptions').flush({ sub: 's', ticket: 't' }));
      expect(push.permission()).toBe('granted');
    });

    it('tells a phone not yet allowed from one that refused', async () => {
      const { push } = await started();
      expect(push.systemBlock()).toBe('not_allowed');
      expect(push.canOpenSystemSettings()).toBe(false);
      push.permission.set('denied');
      expect(push.systemBlock()).toBe('denied_app');
      expect(push.canOpenSystemSettings()).toBe(true);
      push.permission.set('granted');
      expect(push.systemBlock()).toBeNull();
    });

    it('never asks on a TV', async () => {
      tv = true;
      const { push } = create();
      await push.askInContext('download');
      await push.askInContext('request');
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});

describe('shouldAsk', () => {
  const base: AskState = {
    mode: 'native',
    reason: 'request',
    pushReady: true,
    permission: 'prompt',
    deviceEnabled: false,
    deviceOff: false,
    snooze: { declined: 0, until: 0 },
    now: 1000,
  };
  const ask = (patch: Partial<AskState>) => shouldAsk({ ...base, ...patch });

  it('asks on a phone or a browser that can still show the dialog', () => {
    expect(ask({})).toBe(true);
    expect(ask({ mode: 'web' })).toBe(true);
    expect(ask({ reason: 'party' })).toBe(true);
  });

  it('never asks where there is no system dialog', () => {
    for (const mode of ['toast', 'desktop', 'none'] as const) expect(ask({ mode })).toBe(false);
  });

  it('leaves a denied permission to the settings page', () => {
    expect(ask({ permission: 'denied' })).toBe(false);
    expect(ask({ permission: 'denied', reason: 'download' })).toBe(false);
  });

  it('waits out the snooze and stops after three refusals', () => {
    expect(ask({ snooze: { declined: 1, until: 2000 } })).toBe(false);
    expect(ask({ snooze: { declined: 2, until: 999 } })).toBe(true);
    expect(ask({ snooze: { declined: 3, until: 0 } })).toBe(false);
  });

  it('respects a device switched off in the settings and one already on', () => {
    expect(ask({ deviceOff: true })).toBe(false);
    expect(ask({ deviceEnabled: true, permission: 'granted' })).toBe(false);
    expect(ask({ deviceEnabled: true, permission: 'prompt' })).toBe(true);
    expect(ask({ pushReady: false })).toBe(false);
  });

  it('asks for a download only on a phone that lacks the permission', () => {
    expect(ask({ reason: 'download', pushReady: false })).toBe(true);
    expect(ask({ reason: 'download', permission: 'granted' })).toBe(false);
    expect(ask({ reason: 'download', mode: 'web' })).toBe(false);
  });
});
