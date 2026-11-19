import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { DeviceService } from './device.service';
import { SERVER_SINCE, ServerVersionService, serverSupports } from './server-version.service';

describe('serverSupports', () => {
  it('gates a feature newer than the server', () => {
    expect(serverSupports('5.0.0', '5.1.0')).toBe(false);
    expect(serverSupports('5.1.0', '5.1.0')).toBe(true);
    expect(serverSupports('5.2.3', '5.1.0')).toBe(true);
  });

  it('opens every gate on a dev server', () => {
    expect(serverSupports('5.0.0-dev', '5.1.0')).toBe(true);
  });

  it('lets a pre-release server answer its release', () => {
    expect(serverSupports('5.1.0-beta.1', '5.1.0')).toBe(true);
  });

  it('supports nothing new while the server version is unknown', () => {
    expect(serverSupports(null, '5.1.0')).toBe(false);
  });
});

describe('SERVER_SINCE', () => {
  it('hides every unreleased route from the last release and opens it from 7.0.0', () => {
    for (const since of Object.values(SERVER_SINCE)) {
      expect(serverSupports('6.0.2', since)).toBe(false);
      expect(serverSupports('7.0.0', since)).toBe(true);
    }
  });
});

describe('ServerVersionService.supportsWhenKnown', () => {
  let http: HttpTestingController;
  let service: ServerVersionService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { user: signal(null) } },
        { provide: DeviceService, useValue: { isTv: () => true, isDesktopNative: () => false } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(ServerVersionService);
    TestBed.tick();
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  it('waits on the server with nothing stored, then answers from the stored version and refreshes it', async () => {
    const first = service.supportsWhenKnown('6.1.0');
    http.expectOne('/api/system/version').flush({ version: '6.1.0' });
    expect(await first).toBe(true);

    const next = TestBed.runInInjectionContext(() => new ServerVersionService());
    TestBed.tick();
    expect(await next.supportsWhenKnown('6.1.0')).toBe(true);
    http.expectOne('/api/system/version').flush({ version: '6.0.0' });
    await new Promise((resolve) => setTimeout(resolve));
    expect(next.version()).toBe('6.0.0');
    expect(next.supports('6.1.0')).toBe(false);
  });
});
