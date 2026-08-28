import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginCatalogueComponent } from './plugin-catalogue';

/** An installed plugin still needs a way to reach a newer version, or the only route to an update
 *  is uninstalling — which drops the plugin's data. */

const CATALOG = {
  plugins: [
    {
      id: 'fliks.acme',
      name: 'Acme',
      author: 'Fliks',
      description: 'd',
      kind: 'process',
      installable: [
        { version: '1.0.0', pluginApi: 0, fliks: '>=2.0.0 <3.0.0', zipUrl: 'https://x/1', sha256: 'a' },
        { version: '1.1.0', pluginApi: 0, fliks: '>=2.0.0 <3.0.0', zipUrl: 'https://x/2', sha256: 'b' },
      ],
      hidden: null,
    },
  ],
};

async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

async function createComponent(installed: [string, string][], allowOlderVersions = false) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(PluginCatalogueComponent);
  fixture.componentRef.setInput('installedIds', new Set(installed.map(([id]) => id)));
  fixture.componentRef.setInput('installedVersions', new Map(installed));
  fixture.componentRef.setInput('allowOlderVersions', allowOlderVersions);
  fixture.detectChanges();
  http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([{ id: 1, url: 'https://src', enabled: true }]);
  await settle(fixture);
  http.expectOne({ url: '/api/plugins/sources/1/catalog', method: 'GET' }).flush({
    cachedCatalog: CATALOG,
    lastRefreshedAt: null,
    lastRefreshError: null,
  });
  await settle(fixture);
  return { fixture, http };
}

function buttonLabels(fixture: ComponentFixture<unknown>): string[] {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).map(
    (b) => b.textContent?.trim() ?? '',
  );
}

describe('PluginCatalogueComponent — updating an installed plugin', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('VERDICT: offers the newer version to a plugin already installed on an older one', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.0.0']]);

    expect(fixture.componentInstance.updateTarget(fixture.componentInstance.rows()[0])).toBe('1.1.0');
    expect(buttonLabels(fixture).join(' ')).toContain('settings.plugins.catalogue.switch_to');
  });

  it('offers nothing when the installed version is the catalogue\'s newest', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.1.0']]);

    expect(fixture.componentInstance.updateTarget(fixture.componentInstance.rows()[0])).toBeNull();
    expect(buttonLabels(fixture).join(' ')).not.toContain('settings.plugins.catalogue.switch_to');
  });
});

describe('PluginCatalogueComponent — what a card states', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  function text(fixture: ComponentFixture<unknown>): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  it('VERDICT: states the version running, not every version the catalogue carries', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.0.0']]);

    expect(fixture.componentInstance.installedVersion(fixture.componentInstance.rows()[0])).toBe('1.0.0');
    expect(text(fixture)).toContain('settings.plugins.catalogue.installed_version');
    // The old card listed one badge per installable version, which said nothing about this install.
    expect(fixture.nativeElement.querySelectorAll('.badge-ghost').length).toBe(0);
  });

  it('an outdated install reads as an update, not as merely installed', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.0.0']]);
    expect(text(fixture)).toContain('settings.plugins.catalogue.update_available');
    expect(text(fixture)).not.toContain('settings.plugins.catalogue.installed"');
    expect(fixture.nativeElement.querySelector('.badge-info')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.badge-success')).toBeNull();
  });

  it('an up-to-date install keeps the plain installed badge', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.1.0']]);
    expect(fixture.nativeElement.querySelector('.badge-success')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.badge-info')).toBeNull();
  });

  it('a plugin that is not installed states no version at all', async () => {
    const { fixture } = await createComponent([]);
    expect(fixture.componentInstance.installedVersion(fixture.componentInstance.rows()[0])).toBeNull();
    expect(text(fixture)).not.toContain('settings.plugins.catalogue.installed_version');
    expect(fixture.nativeElement.querySelector('.badge-info')).toBeNull();
  });
});

/**
 * With older versions allowed, the action and the version list are one control: the left half
 * acts, the right half lists what the source offers. A plugin already on the newest version has
 * nothing to act on, so the left half states what runs instead of offering an update.
 */
describe('PluginCatalogueComponent — the version picker', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  function versionButtons(fixture: ComponentFixture<unknown>): string[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.dropdown-content button'),
    ).map((b) => b.querySelector('span')?.textContent?.trim() ?? '');
  }

  it('offers no picker at all while the setting is off', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.0.0']]);
    expect(fixture.nativeElement.querySelector('.dropdown-content')).toBeNull();
  });

  it('VERDICT: lists every version the source offers, newest first', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.0.0']], true);
    expect(versionButtons(fixture)).toEqual(['1.1.0', '1.0.0']);
  });

  it('VERDICT: states the running version on the left half when nothing is newer', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.1.0']], true);
    const row = fixture.componentInstance.rows()[0];

    expect(fixture.componentInstance.primaryVersion(row)).toBeNull();
    expect(buttonLabels(fixture).join(' ')).toContain('settings.plugins.catalogue.version_installed');
    // …and the picker is still there, which is the only way back to an older build.
    expect(versionButtons(fixture)).toEqual(['1.1.0', '1.0.0']);
  });

  it('VERDICT: installs the version picked, not the newest', async () => {
    const { fixture, http } = await createComponent([['fliks.acme', '1.1.0']], true);
    const older = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.dropdown-content button'),
    ).find((b) => b.textContent?.includes('1.0.0'));

    older!.click();
    await settle(fixture);

    const req = http.expectOne({ url: '/api/plugins/sources/1/inspect', method: 'POST' });
    expect(req.request.body).toEqual({ pluginId: 'fliks.acme', version: '1.0.0' });
    req.flush({ pluginId: 'fliks.acme', version: '1.0.0' });
    await settle(fixture);
  });

  it('leaves the installed version unpickable', async () => {
    const { fixture } = await createComponent([['fliks.acme', '1.1.0']], true);
    const installed = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.dropdown-content button'),
    ).find((b) => b.textContent?.includes('1.1.0'));
    expect(installed!.disabled).toBe(true);
  });
});
