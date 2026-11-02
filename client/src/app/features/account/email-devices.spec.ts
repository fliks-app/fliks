import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EmailDevice, EmailDevicesApiService } from '../../core/services/api/email-devices-api.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { AccountEmailDevicesComponent } from './email-devices';

const device = (id: number): EmailDevice => ({
  id,
  name: `reader ${id}`,
  kind: 'kindle',
  address: 'me@kindle.com',
  formats: ['epub'],
  createdAt: '2026-11-02T10:00:00.000Z',
});

function setup(canSend = true) {
  const api = {
    list: vi.fn(async () => ({ enabled: true, canSend, maxBytes: 1, devices: [device(1)] })),
    sends: vi.fn(async () => []),
    create: vi.fn(async () => device(2)),
    remove: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: EmailDevicesApiService, useValue: api },
      { provide: AuthService, useValue: { hasPermission: (p: string) => p === 'settings.access' } },
      { provide: ConfirmationService, useValue: { confirm: async () => true } },
    ],
  });
  const fixture = TestBed.createComponent(AccountEmailDevicesComponent);
  fixture.detectChanges();
  return { api, cmp: fixture.componentInstance };
}

describe('AccountEmailDevicesComponent', () => {
  it('lists the devices and creates one from the form', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.devices().length).toBe(1));
    cmp.name.set('  Kitchen  ');
    cmp.address.set(' me@kindle.com ');
    await cmp.create();
    expect(api.create).toHaveBeenCalledWith({ name: 'Kitchen', kind: 'kindle', address: 'me@kindle.com' });
    expect(cmp.name()).toBe('');
  });

  it('offers the other kind only to who manages settings', () => {
    const { cmp } = setup();
    expect(cmp.kinds).toContain('other');
  });

  it('knows when the role cannot send', async () => {
    const { cmp } = setup(false);
    await vi.waitFor(() => expect(cmp.canSend()).toBe(false));
  });

  it('removes a device after confirmation', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.devices().length).toBe(1));
    await cmp.remove(device(1));
    expect(api.remove).toHaveBeenCalledWith(1);
    expect(cmp.devices()).toEqual([]);
  });
});
