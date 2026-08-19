import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of, throwError } from 'rxjs';
import { SetupComponent } from './setup';
import { ServerConfigService } from '../../core/services/server-config.service';
import { AuthService } from '../../core/services/auth.service';

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
