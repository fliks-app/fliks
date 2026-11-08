import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { OptimizeService } from '../../../core/services/api/optimize.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import { ToastService } from '../../../core/services/toast.service';
import { OptimizeWorkersComponent } from './optimize-workers';

const token = (id: number) => ({
  id,
  name: `t${id}`,
  enabled: true,
  pathAccess: 'none',
  pathMappings: [],
  lastSeenAt: null,
});

function setup(clipboard: () => Promise<void>) {
  const api = {
    workerTokens: vi.fn(async () => [token(1), token(2)]),
    workers: vi.fn(async () => []),
    patchWorkerToken: vi.fn(async () => undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: OptimizeService, useValue: api },
      { provide: SettingsApiService, useValue: { getAll: async () => ({}) } },
      { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: ConfirmationService, useValue: {} },
    ],
  });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboard },
    configurable: true,
  });
  return { c: TestBed.createComponent(OptimizeWorkersComponent).componentInstance, api };
}

describe('OptimizeWorkersComponent', () => {
  it('keeps the unsaved edit of a token when another one is toggled', async () => {
    const { c } = setup(async () => undefined);
    await c.ngOnInit();
    c.setAccess(c.tokens()[0], 'shared');
    await c.toggle(c.tokens()[1]);
    expect(c.dirty(c.tokens()[0])).toBe(true);
    expect(c.publicUrlSet()).toBe(false);
  });

  it('does not throw when the clipboard is unavailable', async () => {
    const { c } = setup(async () => {
      throw new Error('no clipboard');
    });
    c.issued.set({ id: 1, name: 'x', token: 'fkw_x' } as never);
    await expect(c.copyIssued()).resolves.toBeUndefined();
  });
});
