import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginSettingsComponent } from './plugin-settings';
import { ToastService } from '../../../../core/services/toast.service';

/** Lets the promise chain inside the component advance between two flushes. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * The catalogue reads what a source's last refresh cached, and that cache was filtered under
 * whichever value the compatibility setting had at the time. Saving the toggle without
 * refreshing leaves the admin looking at the old, narrower list and no way to tell why.
 */
describe('PluginSettingsComponent — disabling the compatibility check', () => {
  function setup() {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTranslateService({
          lang: 'en',
          loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
        }),
        { provide: ToastService, useValue: { success: () => undefined } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const component = TestBed.createComponent(PluginSettingsComponent).componentInstance;
    return { component, http };
  }

  it('VERDICT: refreshes every source so the wider version list appears', async () => {
    const { component, http } = setup();
    const done = component.toggleSkipCompatibility(true);

    http
      .expectOne({ url: '/api/settings/plugins.skip_compatibility_check', method: 'PUT' })
      .flush({ key: 'plugins.skip_compatibility_check', value: 'true' });
    await tick();
    http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([{ id: 1 }, { id: 2 }]);
    await tick();
    http.expectOne({ url: '/api/plugins/sources/1/refresh', method: 'POST' }).flush({ ok: true });
    http.expectOne({ url: '/api/plugins/sources/2/refresh', method: 'POST' }).flush({ ok: true });
    await done;

    expect(component.skipCompatibility()).toBe(true);
    http.verify();
  });

  it('VERDICT: reverts the toggle and refreshes nothing when the write fails', async () => {
    const { component, http } = setup();
    const done = component.toggleSkipCompatibility(true);

    http
      .expectOne({ url: '/api/settings/plugins.skip_compatibility_check', method: 'PUT' })
      .flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await done;

    expect(component.skipCompatibility()).toBe(false);
    // No source call at all: the value the catalogue would be filtered under never changed.
    http.verify();
  });

  it('a source that fails to refresh does not fail the toggle', async () => {
    const { component, http } = setup();
    const done = component.toggleSkipCompatibility(true);

    http
      .expectOne({ url: '/api/settings/plugins.skip_compatibility_check', method: 'PUT' })
      .flush({ key: 'plugins.skip_compatibility_check', value: 'true' });
    await tick();
    http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([{ id: 1 }]);
    await tick();
    http
      .expectOne({ url: '/api/plugins/sources/1/refresh', method: 'POST' })
      .flush({ message: 'unreachable' }, { status: 502, statusText: 'Bad Gateway' });
    await done;

    expect(component.skipCompatibility()).toBe(true);
    expect(component.saving()).toBe(false);
    http.verify();
  });
});
