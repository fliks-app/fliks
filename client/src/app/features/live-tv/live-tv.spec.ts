import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { LiveTvComponent } from './live-tv';
import type { OnNowEntry, OnNowPage } from '../../core/services/api/livetv-api.service';

/** Lets the promise chain inside the component advance between two flushes. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const onNowPage = (entries: OnNowEntry[], total: number): OnNowPage => ({
  entries,
  page: 1,
  pageSize: 50,
  total,
});

const entry = (id: number, name: string): OnNowEntry => ({
  channel: {
    id,
    name,
    number: id,
    logoPath: null,
    groupName: null,
    favorite: false,
    hidden: false,
  },
  now: null,
  next: null,
});

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
 * A typed search used to drive `filteredEntries` client-side while `autoLoadForFilter`
 * paginated the *entire* lineup into memory to feed it (live-tv.ts pre-fix). On a large
 * lineup that meant one HTTP request per 50 channels, fired back-to-back on every
 * keystroke. `on-now` now filters server-side, so a search is one debounced request.
 */
describe('LiveTvComponent — on-now search', () => {
  /** Creates the component and flushes the two requests `ngOnInit` fires on its own. */
  async function setup() {
    TestBed.configureTestingModule({ providers: testProviders() });
    const http = TestBed.inject(HttpTestingController);
    const component = TestBed.createComponent(LiveTvComponent).componentInstance;
    await tick();
    http.expectOne({ url: '/api/livetv/channels', method: 'GET' }).flush([]);
    http
      .expectOne((r) => r.url === '/api/livetv/channels/on-now' && r.params.get('page') === '1')
      .flush(onNowPage([], 0));
    await tick();
    return { component, http };
  }

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  it('emits a single debounced request carrying the query', async () => {
    const { component, http } = await setup();
    vi.useFakeTimers();

    // Simulated keystrokes, each re-arming the debounce timer.
    component.onQueryInput('b');
    await vi.advanceTimersByTimeAsync(50);
    component.onQueryInput('bb');
    await vi.advanceTimersByTimeAsync(50);
    component.onQueryInput('bbc');

    // Still inside the debounce window: nothing sent yet.
    http.expectNone((r) => r.url === '/api/livetv/channels/on-now');

    await vi.advanceTimersByTimeAsync(350);

    const req = http.expectOne(
      (r) => r.url === '/api/livetv/channels/on-now' && r.params.get('query') === 'bbc',
    );
    req.flush(onNowPage([], 0));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('drops a stale response overtaken by a newer query', async () => {
    const { component, http } = await setup();
    vi.useFakeTimers();

    component.onQueryInput('bbc');
    await vi.advanceTimersByTimeAsync(350);
    const stale = http.expectOne(
      (r) => r.url === '/api/livetv/channels/on-now' && r.params.get('query') === 'bbc',
    );

    component.onQueryInput('cnn');
    await vi.advanceTimersByTimeAsync(350);
    const fresh = http.expectOne(
      (r) => r.url === '/api/livetv/channels/on-now' && r.params.get('query') === 'cnn',
    );

    // The overtaken request answers last — it must not clobber the fresher list.
    stale.flush(onNowPage([entry(1, 'BBC One')], 1));
    await vi.advanceTimersByTimeAsync(0);
    fresh.flush(onNowPage([entry(2, 'CNN')], 1));
    await vi.advanceTimersByTimeAsync(0);

    expect(component.entries().map((e) => e.channel.name)).toEqual(['CNN']);
  });

  it('keeps the error state distinct from the empty state', async () => {
    const { component, http } = await setup();

    // Nothing loaded and no failure: a genuine empty lineup.
    expect(component.isEmpty()).toBe(true);
    expect(component.loadError()).toBe(false);

    void component.load(true);
    http
      .expectOne((r) => r.url === '/api/livetv/channels/on-now' && r.params.get('page') === '1')
      .flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await tick();

    expect(component.loadError()).toBe(true);
    expect(component.isEmpty()).toBe(false);
  });
});
