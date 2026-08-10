import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, provideAppInitializer } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { loadPersistedState } from './app.config';

/** The rest of the chain (localStorage-backed) settles in one microtask;
 *  the plugin registry's HTTP call lands a few ticks later — poll for it
 *  instead of assuming it is already in flight. */
async function flushPluginUiRequest(http: HttpTestingController): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const [req] = http.match('/api/plugins/ui');
    if (req) {
      req.flush([]);
      return;
    }
    await Promise.resolve();
  }
  throw new Error('GET /api/plugins/ui was never issued');
}

/** The app initializer gates bootstrap: if it throws or never settles, the
 *  native builds stay on their splash screen forever. */
describe('loadPersistedState', () => {
  it('resolves inside an injection context', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        provideAppInitializer(loadPersistedState),
      ],
    });
    const status = TestBed.inject(ApplicationInitStatus);
    await Promise.all([status.donePromise, flushPluginUiRequest(TestBed.inject(HttpTestingController))]);
    expect(status.done).toBe(true);
  });
});
