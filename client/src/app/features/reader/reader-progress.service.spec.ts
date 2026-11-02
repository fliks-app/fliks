import { TestBed } from '@angular/core/testing';
import { PROGRESS_DEBOUNCE_MS, ReaderProgressService } from './reader-progress.service';
import { ReaderApiService } from './reader-api.service';

const at = (progression: number) => ({ progression, locator: { p: progression } });

const T = { mediaId: 3, itemId: 7, fileId: 9 };

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
    svc.report(T, at(0.1));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    expect(save).not.toHaveBeenCalled();
  });

  it('collapses a burst of positions into one save of the latest', async () => {
    svc.report(T, at(0.1));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    svc.report(T, at(0.2));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    svc.report(T, at(0.3));
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(T, at(0.3));
  });

  it('saves again after a later pause', async () => {
    svc.report(T, at(0.1));
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    svc.report(T, at(0.5));
    await vi.advanceTimersByTimeAsync(PROGRESS_DEBOUNCE_MS);
    expect(save.mock.calls.map((c) => c[1].progression)).toEqual([0.1, 0.5]);
  });

  it('flushes the pending position at once, then not again', async () => {
    svc.report(T, at(0.4));
    await svc.flush();
    expect(save).toHaveBeenCalledWith(T, at(0.4));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS * 2);
    await svc.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('sends a flush only after the save in flight ended', async () => {
    let release!: () => void;
    save.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    svc.report(T, at(0.1));
    const first = svc.flush();
    svc.report(T, at(0.2));
    const second = svc.flush();
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(save.mock.calls.map((c) => c[1].progression)).toEqual([0.1, 0.2]);
  });

  it('drops a failed save without throwing', async () => {
    save.mockRejectedValueOnce(new Error('offline'));
    svc.report(T, at(0.4));
    await expect(svc.flush()).resolves.toBeUndefined();
  });
});
