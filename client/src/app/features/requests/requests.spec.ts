import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, type ParamMap } from '@angular/router';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject, EMPTY, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProfilesService } from '../../core/services/api/profiles.service';
import { LibrariesApiService } from '../../core/services/api/libraries-api.service';
import { RequestsService } from '../../core/services/api/requests.service';
import { AppResumeService } from '../../core/services/app-resume.service';
import { AuthService } from '../../core/services/auth.service';
import { ConfirmationService } from '../../core/services/confirmation.service';
import { DownloadProgressService } from '../../core/services/download-progress.service';
import { NavbarService } from '../../core/services/navbar.service';
import { CachingReuseStrategy } from '../../core/services/route-reuse.strategy';
import { ScrollMemoryService } from '../../core/services/scroll-memory.service';
import { SseService } from '../../core/services/sse.service';
import { ToastService } from '../../core/services/toast.service';
import { sseStub } from '../../testing/sse.stub';
import { RequestsComponent } from './requests';

interface SetupOpts {
  rows?: { id: number; status: string }[];
  approve?: (id: number) => Promise<unknown>;
  confirm?: () => Promise<boolean>;
}

function setup(opts: SetupOpts = {}) {
  const query = new BehaviorSubject<ParamMap>(convertToParamMap({}));
  const list = vi.fn(async () => ({ data: opts.rows ?? [], total: opts.rows?.length ?? 0, page: 1, pageSize: 25 }));
  const approve = vi.fn(opts.approve ?? (async () => ({})));
  const confirm = vi.fn(opts.confirm ?? (async () => true));
  const toast = { success: vi.fn(), error: vi.fn() };
  const sse = sseStub();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: query.value }, queryParamMap: query } },
      { provide: RequestsService, useValue: { list, approve } },
      { provide: ProfilesService, useValue: { getQualityProfiles: async () => [], getLanguageProfiles: async () => [] } },
      { provide: LibrariesApiService, useValue: { listMine: async () => [] } },
      { provide: ConfirmationService, useValue: { confirm } },
      { provide: ToastService, useValue: toast },
      { provide: ScrollMemoryService, useValue: { activate: vi.fn(), deactivateIf: vi.fn(), restoreSticky: vi.fn() } },
      { provide: SseService, useValue: sse },
      { provide: DownloadProgressService, useValue: { progress: signal(new Map()) } },
      { provide: AuthService, useValue: { user: signal({ id: 1 }), hasPermission: () => true } },
      { provide: CachingReuseStrategy, useValue: { attached$: EMPTY, detached$: EMPTY, keyFor: () => 'requests' } },
      { provide: NavbarService, useValue: { navigatedBack: () => false } },
      { provide: AppResumeService, useValue: { resume$: EMPTY } },
    ],
  });
  TestBed.overrideComponent(RequestsComponent, { set: { template: '', imports: [] } });
  const fixture = TestBed.createComponent(RequestsComponent);
  fixture.detectChanges();
  return { cmp: fixture.componentInstance, query, list, sse, approve, confirm, toast };
}

const statusOfLastFetch = (list: ReturnType<typeof vi.fn>) => (list.mock.calls.at(-1) as unknown as [{ status?: string }])[0].status;

describe('RequestsComponent', () => {
  it('filters a page already on screen when a push lands on /requests?status=pending', async () => {
    const { cmp, query, list } = setup();
    await Promise.resolve();
    expect(cmp.statusFilter()).toBe('');

    query.next(convertToParamMap({ status: 'pending' }));
    await Promise.resolve();

    expect(cmp.statusFilter()).toBe('pending');
    expect(statusOfLastFetch(list)).toBe('pending');
  });

  it('keeps the chosen filter when the same status is pushed again', async () => {
    const { cmp, query } = setup();
    query.next(convertToParamMap({ status: 'pending' }));
    cmp.onStatusChange('approved');

    query.next(convertToParamMap({ status: 'pending' }));

    expect(cmp.statusFilter()).toBe('approved');
  });

  it('refetches when one of the user requests changes status, and only then', async () => {
    const { list, sse } = setup();
    await Promise.resolve();
    const before = list.mock.calls.length;

    sse.notifications.next({ cat: 'parties' } as never);
    expect(list.mock.calls.length).toBe(before);

    sse.notifications.next({ cat: 'requests' } as never);
    expect(list.mock.calls.length).toBe(before + 1);
  });

  describe('approve all', () => {
    const rows = [
      { id: 1, status: 'pending' },
      { id: 2, status: 'pending' },
      { id: 3, status: 'approved' },
    ];
    const pendingSetup = async (opts: SetupOpts) => {
      const h = setup({ rows, ...opts });
      h.cmp.statusFilter.set('pending');
      h.cmp.reload();
      await vi.waitFor(() => expect(h.cmp.rows().length).toBe(3));
      return h;
    };

    it('counts the pending rows, on the Pending filter only', async () => {
      const { cmp } = await pendingSetup({});
      expect(cmp.approvableRows().map((r) => r.id)).toEqual([1, 2]);
      cmp.statusFilter.set('');
      expect(cmp.approvableRows()).toEqual([]);
    });

    it('approves each row in order after the confirm and refreshes', async () => {
      const { cmp, approve, toast, list } = await pendingSetup({});
      const calls = list.mock.calls.length;
      await cmp.approveAll();
      expect(approve.mock.calls.map((c) => c[0])).toEqual([1, 2]);
      expect(toast.success).toHaveBeenCalled();
      expect(list.mock.calls.length).toBeGreaterThan(calls);
    });

    it('does nothing when the confirm is declined', async () => {
      const { cmp, approve } = await pendingSetup({ confirm: async () => false });
      await cmp.approveAll();
      expect(approve).not.toHaveBeenCalled();
    });

    it('keeps going and toasts a partial failure', async () => {
      const { cmp, approve, toast } = await pendingSetup({
        approve: async (id) => (id === 1 ? Promise.reject(new Error('x')) : {}),
      });
      await cmp.approveAll();
      expect(approve).toHaveBeenCalledTimes(2);
      expect(toast.error).toHaveBeenCalledWith('requests.approve_all_partial');
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
