import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from '../../core/services/auth.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { PendingRequestsComponent } from './pending-requests';

const found = {
  pairingId: 'pid-1',
  deviceName: 'TV',
  systemName: 'tvOS 26',
  clientIp: '10.0.0.2',
  requestedAt: new Date().toISOString(),
};

function setup() {
  const auth = {
    user: () => ({ id: 1 }),
    pairingPending: vi.fn(async () => []),
    pairingLookup: vi.fn(async () => found),
    pairingApprove: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: AuthService, useValue: auth },
      { provide: SseService, useValue: { pairingEvents: new Subject() } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: Router, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(PendingRequestsComponent);
  fixture.detectChanges();
  return { auth, cmp: fixture.componentInstance };
}

describe('PendingRequestsComponent: code confirmation', () => {
  it('looks the code up, then approves the looked-up request', async () => {
    const { auth, cmp } = setup();
    cmp.code.set('123 456');
    await cmp.lookup(new Event('submit'));
    expect(auth.pairingLookup).toHaveBeenCalledWith('123 456');
    expect(auth.pairingApprove).not.toHaveBeenCalled();
    await cmp.approve();
    expect(auth.pairingApprove).toHaveBeenCalledWith('123 456', 'pid-1');
    expect(cmp.found()).toBeNull();
  });

  it('drops the confirmation when it is cancelled', async () => {
    const { cmp } = setup();
    cmp.code.set('123456');
    await cmp.lookup(new Event('submit'));
    cmp.cancelLookup();
    await cmp.approve();
    expect(cmp.found()).toBeNull();
  });
});
