import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of, throwError } from 'rxjs';
import { SetupComponent } from './setup';
import { ServerConfigService } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';

/** Reachable over https only — mirrors a host whose http port 301s to https. */
const httpsOnly = {
  get: (url: string) =>
    url.startsWith('https://')
      ? throwError(() => ({ status: 401 }))
      : throwError(() => ({ status: 0 })),
} as unknown as HttpClient;

async function createComponent(http: HttpClient) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: HttpClient, useValue: http },
      {
        provide: ServerConfigService,
        useValue: { serverUrl: () => '', knownServers: signal([]) },
      },
      {
        provide: AuthService,
        useValue: { switchToServer: () => Promise.resolve(), serversWithSession: () => new Set() },
      },
    ],
  });
  const fixture = TestBed.createComponent(SetupComponent);
  await fixture.whenStable();
  return fixture.componentInstance;
}

describe('SetupComponent — https fallback', () => {
  it('retries an http entry over https and keeps the working base', async () => {
    const c = await createComponent(httpsOnly);
    c.url.set('http://fliks.example.com');

    await c.test();

    expect(c.testResult()).toEqual({ ok: true, message: 'setup.test_success' });
    expect(c.url()).toBe('https://fliks.example.com');
  });

  it('keeps an http entry that answers over http', async () => {
    const reachable = { get: () => throwError(() => ({ status: 401 })) } as unknown as HttpClient;
    const c = await createComponent(reachable);
    c.url.set('http://192.168.1.10:3001');

    await c.test();

    expect(c.testResult()?.ok).toBe(true);
    expect(c.url()).toBe('http://192.168.1.10:3001');
  });

  it('reports an error when neither scheme answers', async () => {
    const dead = { get: () => throwError(() => ({ status: 0 })) } as unknown as HttpClient;
    const c = await createComponent(dead);
    c.url.set('http://nope.example.com');

    await c.test();

    expect(c.testResult()).toEqual({ ok: false, message: 'setup.test_error' });
  });
});

describe('SetupComponent — known server', () => {
  const server = { url: 'https://fliks.example.com', name: null, lastUsedAt: 0, lastUsername: null };

  it('switches only once the server answers', async () => {
    const reachable = { get: () => throwError(() => ({ status: 401 })) } as unknown as HttpClient;
    const c = await createComponent(reachable);
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'switchToServer').mockResolvedValue();

    await c.useKnown(server);

    expect(auth.switchToServer).toHaveBeenCalledWith(server.url);
  });

  it('stays on the page with an error when the server is down', async () => {
    const dead = { get: () => throwError(() => ({ status: 0 })) } as unknown as HttpClient;
    const c = await createComponent(dead);
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'switchToServer').mockResolvedValue();

    await c.useKnown(server);

    expect(auth.switchToServer).not.toHaveBeenCalled();
    expect(TestBed.inject(ToastService).toasts()[0]?.type).toBe('error');
    expect(c.switchingTo()).toBeNull();
  });
});
