import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { PushService } from './push.service';
import { ServerConfigService } from './server-config.service';
import { ServerVersionService } from './server-version.service';
import { SseService } from './sse.service';
import { ToastService } from './toast.service';

const PENDING = 'fliks.push.pendingUrl';

describe('PushService', () => {
  const user = signal<{ id: number } | null>({ id: 1 });
  const resumeSession = vi.fn();
  const switchToServer = vi.fn();
  const navigateByUrl = vi.fn();
  const toastError = vi.fn();

  function create(): { push: PushService; http: HttpTestingController } {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user, sessionEpoch: signal(0), resumeSession, switchToServer } },
        { provide: SseService, useValue: { notifications: new Subject() } },
        { provide: ToastService, useValue: { error: toastError } },
        { provide: TranslateService, useValue: { instant: (k: string) => k, currentLang: () => 'en' } },
        { provide: DeviceService, useValue: { isTv: () => false, isDesktopNative: () => false } },
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
  });

  describe('opened', () => {
    it('navigates inside the current session', async () => {
      const { push } = create();
      await push.opened({ url: '/requests', session: { serverUrl: 'https://a.test', userId: 1, key: 'k' } });
      expect(navigateByUrl).toHaveBeenCalledWith('/requests');
      expect(resumeSession).not.toHaveBeenCalled();
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
});
