import { provideZonelessChangeDetection } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { SystemInfoService } from '../../core/services/system-info.service';
import { QuickConnectWaitComponent } from './quick-connect-wait';

function setup(request: () => Promise<unknown>, userId: string | null) {
  const auth = { pairingRequest: vi.fn((..._args: unknown[]) => request()), pairingCancel: vi.fn(async () => undefined) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: AuthService, useValue: auth },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => userId } } } },
      {
        provide: SystemInfoService,
        useValue: { ready: async () => undefined, systemName: () => '', deviceName: () => '' },
      },
    ],
  });
  const cmp = TestBed.createComponent(QuickConnectWaitComponent).componentInstance;
  cmp.ngOnInit();
  return { auth, cmp, router: TestBed.inject(Router) as unknown as { navigate: ReturnType<typeof vi.fn> } };
}

const invalid = () =>
  Promise.reject(
    new HttpErrorResponse({ status: 400, error: { message: ['userId should not be empty'] } }),
  );

describe('QuickConnectWaitComponent: userless request', () => {
  it('requests without a user and shows the outdated view on an old server', async () => {
    const { auth, cmp } = setup(invalid, null);
    await vi.waitFor(() => expect(cmp.view()).toBe('outdated'));
    expect(auth.pairingRequest.mock.calls[0]![0]).toBeNull();
  });

  it('keeps the generic error when a picked user fails', async () => {
    const { cmp } = setup(invalid, '7');
    await vi.waitFor(() => expect(cmp.view()).toBe('error'));
  });

  it('cancel returns to select-user without auto-launching SSO', async () => {
    const { cmp, router } = setup(invalid, '7');
    cmp.cancel();
    expect(router.navigate).toHaveBeenCalledWith(['/select-user'], { queryParams: { autoLaunch: 0 } });
  });
});
