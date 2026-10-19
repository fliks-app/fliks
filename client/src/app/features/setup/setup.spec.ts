import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { NEVER, of, throwError } from 'rxjs';
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

async function createComponent(http: HttpClient, activeUrl = '') {
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
        useValue: {
          serverUrl: () => activeUrl,
          knownServers: signal([]),
          updateKnownServer: (_: string, c: { url: string }) => Promise.resolve(c.url),
        },
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

describe('SetupComponent — editing during a test', () => {
  it('cancels the pending test', async () => {
    const hanging = { get: () => NEVER } as unknown as HttpClient;
    const c = await createComponent(hanging);
    c.url.set('http://slow.example.com');

    const pending = c.test();
    c.onUrlChange('http://other.example.com');
    await pending;

    expect(c.testing()).toBe(false);
    expect(c.testResult()).toBeNull();
    expect(c.url()).toBe('http://other.example.com');
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

describe('SetupComponent — editing a known server', () => {
  const server = { url: 'https://old.example.com', name: null, lastUsedAt: 0, lastUsername: null };

  beforeAll(() => {
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });

  async function editTo(activeUrl: string) {
    const c = await createComponent({} as HttpClient, activeUrl);
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'switchToServer').mockResolvedValue();
    c.editing.set(server);
    c.editUrl.set('https://new.example.com');
    await c.confirmEdit();
    return auth;
  }

  it('reconnects to the new address when the active server moves', async () => {
    const auth = await editTo(server.url);
    expect(auth.switchToServer).toHaveBeenCalledWith('https://new.example.com');
  });

  it('leaves the active server alone when another one is edited', async () => {
    const auth = await editTo('https://elsewhere.example.com');
    expect(auth.switchToServer).not.toHaveBeenCalled();
  });
});
