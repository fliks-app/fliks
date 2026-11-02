import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  DeviceToken,
  DeviceTokensApiService,
} from '../../core/services/api/device-tokens-api.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { AccountDevicesComponent } from './devices';

const row = (id: number): DeviceToken => ({
  id,
  name: `reader ${id}`,
  kind: 'opds',
  createdAt: '2026-11-02T10:00:00.000Z',
  lastUsedAt: null,
});

function setup(confirmed = true) {
  const api = {
    list: vi.fn(async () => [row(1)]),
    create: vi.fn(async (name: string) => ({ ...row(2), name, token: 'fkd_secret' })),
    renew: vi.fn(async (id: number) => ({ ...row(id), token: 'fkd_renewed' })),
    revoke: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: DeviceTokensApiService, useValue: api },
      { provide: ConfirmationService, useValue: { confirm: async () => confirmed } },
    ],
  });
  const fixture = TestBed.createComponent(AccountDevicesComponent);
  fixture.detectChanges();
  return { api, cmp: fixture.componentInstance, fixture };
}

describe('AccountDevicesComponent', () => {
  it('lists the tokens and keeps the plaintext of a new one in memory only', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.devices().length).toBe(1));
    cmp.name.set('  Kitchen  ');
    cmp.kind.set('kosync');
    await cmp.create();
    expect(api.create).toHaveBeenCalledWith('Kitchen', 'kosync');
    expect(cmp.issued()?.token).toBe('fkd_secret');
    expect(cmp.name()).toBe('');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('does not create with a blank name', async () => {
    const { api, cmp } = setup();
    cmp.name.set('   ');
    await cmp.create();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('revokes only after the confirmation, and drops the row and a shown token', async () => {
    const { api, cmp } = setup(false);
    await vi.waitFor(() => expect(cmp.devices().length).toBe(1));
    await cmp.revoke(cmp.devices()[0]);
    expect(api.revoke).not.toHaveBeenCalled();
    TestBed.resetTestingModule();
    const ok = setup(true);
    await vi.waitFor(() => expect(ok.cmp.devices().length).toBe(1));
    ok.cmp.issued.set({ ...row(1), token: 'fkd_x' });
    await ok.cmp.revoke(ok.cmp.devices()[0]);
    expect(ok.api.revoke).toHaveBeenCalledWith(1);
    expect(ok.cmp.devices()).toEqual([]);
    expect(ok.cmp.issued()).toBeNull();
  });

  it('shows the renewed token once', async () => {
    const { api, cmp } = setup();
    await vi.waitFor(() => expect(cmp.devices().length).toBe(1));
    await cmp.renew(cmp.devices()[0]);
    expect(api.renew).toHaveBeenCalledWith(1);
    expect(cmp.issued()?.token).toBe('fkd_renewed');
  });
});
