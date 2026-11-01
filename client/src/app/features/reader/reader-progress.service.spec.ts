import { TestBed } from '@angular/core/testing';
import { PROGRESS_DEBOUNCE_MS, ReaderProgressService } from './reader-progress.service';
import { ReaderApiService } from './reader-api.service';

const at = (progression: number) => ({ progression, locator: `{"p":${progression}}` });

describe('ReaderProgressService', () => {
  let save: ReturnType<typeof vi.fn>;
  let svc: ReaderProgressService;

  beforeEach(() => {
    vi.useFakeTimers();
    save = vi.fn().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [ReaderProgressService, { provide: ReaderApiService, useValue: { saveProgress: save } }],
    });
    svc = TestBed.inject(ReaderProgressService);
  });

  afterEach(() => vi.useRealTimers());

  it('sends nothing before the pause ends', () => {
    svc.report(7, at(0.1));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
  });

  it('collapses a burst of positions into one save of the latest', () => {
    svc.report(7, at(0.1));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    svc.report(7, at(0.2));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    svc.report(7, at(0.3));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(7, at(0.3));
  });

  it('saves again after a later pause', () => {
    svc.report(7, at(0.1));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS);
    svc.report(7, at(0.5));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS);
    expect(save.mock.calls.map((c) => c[1].progression)).toEqual([0.1, 0.5]);
  });

  it('flushes the pending position at once, then not again', async () => {
    svc.report(7, at(0.4));
    await svc.flush();
    expect(save).toHaveBeenCalledWith(7, at(0.4));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS * 2);
    await svc.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('drops a failed save without throwing', async () => {
    save.mockRejectedValueOnce(new Error('offline'));
    svc.report(7, at(0.4));
    await expect(svc.flush()).resolves.toBeUndefined();
  });
});
