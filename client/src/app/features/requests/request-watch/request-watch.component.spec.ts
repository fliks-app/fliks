import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RequestsService, type TitleRequestState } from '../../../core/services/api/requests.service';
import { ToastService } from '../../../core/services/toast.service';
import { RequestWatchComponent } from './request-watch.component';

const base: TitleRequestState = {
  requested: true,
  watching: false,
  requesterCount: 2,
  requestedByMe: false,
  requestId: 7,
  wholeSeriesRequested: false,
  requestedSeasons: [],
  profilesLocked: false,
  lockedQualityProfileId: null,
  lockedLanguageProfileId: null,
};

function setup(state: Partial<TitleRequestState>, opts: { canManage?: boolean; watch?: () => Promise<unknown> } = {}) {
  const requests = {
    watch: vi.fn(opts.watch ?? (async () => undefined)),
    unwatch: vi.fn(async () => undefined),
    approve: vi.fn(async () => ({})),
    get: vi.fn(async () => ({
      id: 7,
      status: 'pending',
      createdAt: '2026-11-12T10:00:00Z',
      user: { id: 1, username: 'Ana' },
      watchers: [{ id: 2, username: 'Tom', createdAt: '2026-11-18T10:00:00Z' }],
    })),
  };
  const toast = { success: vi.fn(), error: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: RequestsService, useValue: requests },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(RequestWatchComponent);
  fixture.componentRef.setInput('state', { ...base, ...state });
  fixture.componentRef.setInput('canManage', opts.canManage ?? false);
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, requests, toast, changed };
}

const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('RequestWatchComponent', () => {
  it('offers "notify me" and the requester count to a plain user', () => {
    const { el } = setup({});
    expect(buttons(el)).toContain('requests.watch');
    expect(el.textContent).toContain('requests.requested_by_people');
  });

  it('watches, toasts and asks the host to refetch', async () => {
    const { el, requests, toast, changed } = setup({});
    (el.querySelector('button') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests.watch).toHaveBeenCalledWith(7);
    expect(toast.success).toHaveBeenCalledWith('requests.watch_success');
    expect(changed).toHaveBeenCalled();
  });

  it('toasts the failure and keeps the state when watching fails', async () => {
    const { el, toast, changed } = setup({}, { watch: async () => Promise.reject(new Error('x')) });
    (el.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('requests.watch_error'));
    expect(changed).not.toHaveBeenCalled();
  });

  it('shows the notified state to a watcher', () => {
    const { el } = setup({ watching: true });
    expect(el.textContent).toContain('requests.watching');
    expect(buttons(el)).not.toContain('requests.watch');
  });

  it('shows the owner their own request, without a watch button', () => {
    const { el } = setup({ requestedByMe: true });
    expect(el.textContent).toContain('requests.you_requested');
    expect(buttons(el)).not.toContain('requests.watch');
  });

  it('gives a manager Approve and the names line', async () => {
    const { fixture, el, requests, changed } = setup({}, { canManage: true });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(requests.get).toHaveBeenCalledWith(7);
    const approve = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('requests.approve')) as HTMLButtonElement;
    expect(approve).toBeTruthy();
    expect(el.textContent).toContain('requests.requested_by_and_others');
    approve.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(requests.approve).toHaveBeenCalledWith(7);
    expect(changed).toHaveBeenCalled();
  });
});
