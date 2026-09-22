import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { LiveTvGuideComponent } from './guide';

/** Lets the promise chain inside the component advance between two flushes. */
const tick = () => new Promise((r) => setTimeout(r, 0));

const guidePage = (total: number) => ({ channels: [], programs: {}, page: 1, pageSize: 50, total });

/**
 * `loadWindow` guards its scroll-triggered (page++) path behind `loadingMore`/`hasMore`, and
 * ties the page counter to the request outcome — both broke when a scrolled-in-flight fetch
 * was overtaken by a filter/window reset (guide.ts:131-163).
 */
describe('LiveTvGuideComponent — loadWindow sequencing', () => {
  /** Creates the component and flushes the two requests `ngOnInit` fires on its own. */
  async function setup(total: number) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
      ],
    });
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
});
