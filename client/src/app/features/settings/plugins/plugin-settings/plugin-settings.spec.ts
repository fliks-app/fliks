import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginSettingsComponent } from './plugin-settings';
import { AuthService } from '../../../../core/services/auth.service';
import { ToastService } from '../../../../core/services/toast.service';

/** Lets the promise chain inside the component advance between two flushes. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * The catalogue reads what a source's last refresh cached, and that cache was filtered under
 * whichever value the compatibility setting had at the time. Saving the toggle without
 * refreshing leaves the admin looking at the old, narrower list and no way to tell why.
 */
describe('PluginSettingsComponent — disabling the compatibility check', () => {
  function setup(isAdmin = true) {
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
        { provide: AuthService, useValue: { user: signal({ isAdmin }) } },
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

describe('PluginSettingsComponent: unsigned plugins switch', () => {
  async function open(isAdmin: boolean) {
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
        { provide: AuthService, useValue: { user: signal({ isAdmin }) } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(PluginSettingsComponent);
    fixture.nativeElement.querySelector('dialog').showModal = () => undefined;
    fixture.detectChanges();
    const opened = fixture.componentInstance.open();
    for (const key of ['plugins.auto_update', 'plugins.skip_compatibility_check', 'plugins.allow_older_versions']) {
      http.expectOne({ url: `/api/settings/${key}`, method: 'GET' }).flush({ key, value: null });
    }
    return { fixture, http, opened };
  }

  it('hides the switch and never reads its admin-only key for a non-admin', async () => {
    const { fixture, http, opened } = await open(false);
    await opened;
    fixture.detectChanges();

    http.expectNone('/api/settings/plugins.allow_unsigned');
    expect(fixture.nativeElement.querySelectorAll('app-toggle-field')).toHaveLength(3);
  });

  it('leaves the compatibility switch disabled for a non-admin', async () => {
    const { fixture, opened } = await open(false);
    await opened;
    fixture.detectChanges();
    await fixture.whenStable();

    const toggles = fixture.nativeElement.querySelectorAll('app-toggle-field input');
    expect(toggles[1].disabled).toBe(true);
    expect(toggles[0].disabled).toBe(false);
  });

  it('offers it to an admin', async () => {
    const { fixture, http, opened } = await open(true);
    http.expectOne({ url: '/api/settings/plugins.allow_unsigned', method: 'GET' }).flush({ key: 'plugins.allow_unsigned', value: 'false' });
    await opened;
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('app-toggle-field')).toHaveLength(4);
  });
});
