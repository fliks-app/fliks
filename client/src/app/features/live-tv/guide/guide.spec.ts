import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvGuideComponent } from './guide';
import type { LiveChannel, LiveProgram } from '../../../core/services/api/livetv-api.service';

/** Lets the promise chain inside the component advance between two flushes. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const guidePage = (total: number) => ({ channels: [], programs: {}, page: 1, pageSize: 50, total });

const testProviders = () => [
  provideZonelessChangeDetection(),
  provideRouter([]),
  provideHttpClient(),
  provideHttpClientTesting(),
  provideTranslateService({
    lang: 'en',
    loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
  }),
];

/**
 * `loadWindow` guards its scroll-triggered (page++) path behind `loadingMore`/`hasMore`, and
 * ties the page counter to the request outcome — both broke when a scrolled-in-flight fetch
 * was overtaken by a filter/window reset (guide.ts:131-163).
 */
describe('LiveTvGuideComponent — loadWindow sequencing', () => {
  /** Creates the component and flushes the two requests `ngOnInit` fires on its own. */
  async function setup(total: number) {
    TestBed.configureTestingModule({ providers: testProviders() });
    const http = TestBed.inject(HttpTestingController);
    const component = TestBed.createComponent(LiveTvGuideComponent).componentInstance;
    await tick();
    http.expectOne({ url: '/api/livetv/channels', method: 'GET' }).flush([]);
    http
      .expectOne((r) => r.url === '/api/livetv/guide' && r.params.get('page') === '1')
      .flush(guidePage(total));
    await tick();
    return { component, http };
  }

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('releases loadingMore when a reset supersedes an in-flight scroll fetch', async () => {
    const { component, http } = await setup(100);

    // Scroll triggers page 2, left in flight.
    void component.loadWindow(false);
    expect(component.loadingMore()).toBe(true);
    const stalePage2 = http.expectOne(
      (r) => r.url === '/api/livetv/guide' && r.params.get('page') === '2',
    );

    // A group/window change resets before page 2 answers.
    void component.loadWindow(true);
    const freshPage1 = http.expectOne(
      (r) => r.url === '/api/livetv/guide' && r.params.get('page') === '1',
    );

    // The stale response arrives last — it must not leave loadingMore stuck.
    stalePage2.flush(guidePage(100));
    await tick();
    expect(component.loadingMore()).toBe(false);

    freshPage1.flush(guidePage(100));
    await tick();
  });

  it('does not skip a page when a scroll fetch fails', async () => {
    const { component, http } = await setup(100);

    // Page 2 fails: the page counter must not have advanced past the failed page.
    void component.loadWindow(false);
    http
      .expectOne((r) => r.url === '/api/livetv/guide' && r.params.get('page') === '2')
      .flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await tick();
    expect(component.loadingMore()).toBe(false);

    // Retrying must request page 2 again, not skip straight to page 3.
    void component.loadWindow(false);
    http
      .expectOne((r) => r.url === '/api/livetv/guide' && r.params.get('page') === '2')
      .flush(guidePage(100));
    await tick();
  });

  it('ignores a stale fetch failure once a newer request has started', async () => {
    const { component, http } = await setup(100);

    // Scroll triggers page 2, left in flight.
    void component.loadWindow(false);
    const stalePage2 = http.expectOne(
      (r) => r.url === '/api/livetv/guide' && r.params.get('page') === '2',
    );

    // A reset supersedes it before it answers.
    void component.loadWindow(true);
    const freshPage1 = http.expectOne(
      (r) => r.url === '/api/livetv/guide' && r.params.get('page') === '1',
    );

    // The stale request fails after being superseded — must not surface as a load error.
    stalePage2.flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await tick();
    expect(component.loadError()).toBe(false);

    freshPage1.flush(guidePage(100));
    await tick();
    expect(component.loadError()).toBe(false);
  });
});

/**
 * `nowProgram`/`nextProgram` used to be baked into each row at fetch time (guide.ts pre-fix),
 * so a program that ended between fetches stayed "now" until the next reload. They're now
 * derived from `rows()` and the minute-interval `clock` signal instead.
 */
describe('LiveTvGuideComponent — now/next follows the clock', () => {
  const channel: LiveChannel = {
    id: 1,
    name: 'Channel',
    number: 1,
    logoPath: null,
    groupName: null,
    favorite: false,
    hidden: false,
    guideChannelId: 'ch1',
  };

  const program = (id: number, startsAt: Date, endsAt: Date): LiveProgram => ({
    id,
    guideChannelId: 'ch1',
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    title: `program-${id}`,
    subtitle: null,
    description: null,
    categories: [],
    iconUrl: null,
    seasonNumber: null,
    episodeNumber: null,
    isNew: false,
    isLive: false,
    rating: null,
    year: null,
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.inject(HttpTestingController).verify();
  });

  it('drops a finished program from "now" once the clock ticks past it, without a new fetch', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 8, 22, 10, 0, 0, 0); // local minute 0, so roundToHalfHour is a no-op
    vi.setSystemTime(now);

    const flush = () => vi.advanceTimersByTimeAsync(0);
    const current = program(
      1,
      new Date(now.getTime() - 30 * 60_000),
      new Date(now.getTime() + 5 * 60_000),
    );
    const upcoming = program(
      2,
      new Date(now.getTime() + 5 * 60_000),
      new Date(now.getTime() + 35 * 60_000),
    );

    TestBed.configureTestingModule({ providers: testProviders() });
    const http = TestBed.inject(HttpTestingController);
    const component = TestBed.createComponent(LiveTvGuideComponent).componentInstance;
    await flush();
    http.expectOne({ url: '/api/livetv/channels', method: 'GET' }).flush([]);
    http
      .expectOne((r) => r.url === '/api/livetv/guide' && r.params.get('page') === '1')
      .flush({
        channels: [channel],
        programs: { ch1: [current, upcoming] },
        page: 1,
        pageSize: 50,
        total: 1,
      });
    await flush();

    expect(component.displayRows()[0].nowProgram?.id).toBe(1);
    expect(component.displayRows()[0].nextProgram?.id).toBe(2);

    // No new fetch — only the minute clock ticking past `current`'s end.
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(component.displayRows()[0].nowProgram?.id).toBe(2);
    expect(component.displayRows()[0].nextProgram).toBeNull();
  });
});
