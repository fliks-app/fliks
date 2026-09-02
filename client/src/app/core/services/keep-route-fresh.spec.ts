import { provideZonelessChangeDetection, runInInjectionContext, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { Subject } from 'rxjs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keepRouteFresh } from './keep-route-fresh';
import { AppResumeService } from './app-resume.service';
import { CachingReuseStrategy } from './route-reuse.strategy';
import { ScrollMemoryService } from './scroll-memory.service';

const OWN_KEY = 'route-7::id=1';

describe('keepRouteFresh', () => {
  let attached$: Subject<string>;
  let detached$: Subject<string>;
  let resume$: Subject<void>;
  let calls: string[];
  let scrollMemory: { activate: ReturnType<typeof vi.fn>; restoreSticky: ReturnType<typeof vi.fn>; deactivateIf: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    attached$ = new Subject<string>();
    detached$ = new Subject<string>();
    resume$ = new Subject<void>();
    calls = [];
    scrollMemory = {
      activate: vi.fn((k: string) => calls.push(`activate:${k}`)),
      restoreSticky: vi.fn((k: string) => calls.push(`restore:${k}`)),
      deactivateIf: vi.fn((k: string) => calls.push(`deactivateIf:${k}`)),
    };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: CachingReuseStrategy, useValue: { attached$, detached$, keyFor: () => OWN_KEY } },
        { provide: ScrollMemoryService, useValue: scrollMemory },
        { provide: AppResumeService, useValue: { resume$ } },
        { provide: ActivatedRoute, useValue: { snapshot: {} } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const bind = (opts: Parameters<typeof keepRouteFresh>[0]) =>
    runInInjectionContext(TestBed.inject(Injector), () => keepRouteFresh(opts));

  it('revalidates on return, between claiming and restoring the scroll key', () => {
    bind({ refresh: () => calls.push('refresh'), scrollKey: 'home' });

    attached$.next(OWN_KEY);

    // The order matters: the key has to be ours before the refresh can shift
    // content, and the restore has to come after it.
    expect(calls).toEqual(['activate:home', 'refresh', 'restore:home']);
  });

  it('follows its own key across a param change', () => {
    // media-detail keeps its instance when only the episode param moves, and is
    // then cached under the episode it last showed. A latched key left the hero
    // navbar (and its series logo) behind on the page navigated to.
    const reuse = TestBed.inject(CachingReuseStrategy) as unknown as {
      keyFor: () => string;
    };
    let key = OWN_KEY;
    reuse.keyFor = () => key;
    bind({ onDetach: () => calls.push('detach'), onAttach: () => calls.push('attach') });

    key = 'route-7::id=1&episodeId=5';
    detached$.next(key);
    attached$.next(key);

    expect(calls).toEqual(['detach', 'attach']);
  });

  it('ignores another route reattaching', () => {
    bind({ refresh: () => calls.push('refresh'), scrollKey: 'home' });

    attached$.next('someone-else');
    detached$.next('someone-else');

    expect(calls).toEqual([]);
  });

  it('tracks the detached state and releases the key only if it is still ours', () => {
    const detached = bind({ scrollKey: 'home' });
    expect(detached()).toBe(false);

    detached$.next(OWN_KEY);
    expect(detached()).toBe(true);
    expect(scrollMemory.deactivateIf).toHaveBeenCalledWith('home');

    attached$.next(OWN_KEY);
    expect(detached()).toBe(false);
  });

  it('refreshes on app-resume only while the page is on screen', () => {
    bind({ refresh: () => calls.push('refresh') });

    resume$.next();
    expect(calls).toEqual(['refresh']);

    detached$.next(OWN_KEY);
    resume$.next();
    expect(calls).toEqual(['refresh']);
  });

  it('prefers refreshOnResume when the page is already painted', () => {
    bind({
      refresh: () => calls.push('refresh'),
      refreshOnResume: () => calls.push('forced'),
    });

    resume$.next();
    expect(calls).toEqual(['forced']);

    attached$.next(OWN_KEY);
    expect(calls).toEqual(['forced', 'refresh']);
  });

  it('skips scroll handling while a computed key is still unknown', () => {
    let key: string | null = null;
    bind({ refresh: () => calls.push('refresh'), scrollKey: () => key });

    attached$.next(OWN_KEY);
    expect(calls).toEqual(['refresh']);

    key = 'library-3';
    attached$.next(OWN_KEY);
    expect(calls).toEqual(['refresh', 'activate:library-3', 'refresh', 'restore:library-3']);
  });
});
