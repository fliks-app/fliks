import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { IndexersSettingsComponent } from './indexers';
import { ProfilesService } from '../../../core/services/api/profiles.service';
import { ConfirmationService } from '../../../core/services/confirmation.service';

/**
 * Drives the page through its rendered DOM and the real HTTP wire, not
 * internal component methods — the seam that survives migrating the CRUD
 * list off hand-rolled signals onto the shared `providers` renderer.
 */
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

function inputForLabel(root: HTMLElement, labelText: string): HTMLInputElement {
  const labels = Array.from(root.querySelectorAll('label'));
  const label = labels.find((l) => l.querySelector('.label-text')?.textContent?.trim() === labelText);
  const input = label?.querySelector('input');
  if (!input) throw new Error(`No input found for label "${labelText}"`);
  return input as HTMLInputElement;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button found with text "${text}"`);
  return btn as HTMLButtonElement;
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

/**
 * `whenStable()` alone can resolve one tick before a chained `Promise.all`
 * (or a signal write inside a native click handler) fully settles under zoneless CD.
 */
async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

async function clickAndSettle(el: HTMLElement, fixture: ComponentFixture<unknown>) {
  el.click();
  await settle(fixture);
}

const ROW = {
  id: 1,
  name: 'MyTracker',
  implementation: 'torznab',
  settings: { baseUrl: 'http://prowlarr:9696/1/api', minSeeders: 5, seedRatio: 2 },
  enableRss: true,
  enableSearch: true,
  priority: 25,
  requestDelay: 2,
  enabled: true,
  cooldown: null as { reason: string; remainingMs: number; until: string; failureCount?: number } | null,
};

function configureTestBed() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ProfilesService, useValue: { getLanguageDefinitions: () => Promise.resolve([]) } },
      { provide: ConfirmationService, useValue: { confirm: () => Promise.resolve(true), alert: () => Promise.resolve() } },
    ],
  });
  return TestBed.inject(HttpTestingController);
}

async function createComponent(rows: (typeof ROW)[] = [ROW]) {
  const http = configureTestBed();
  const fixture = TestBed.createComponent(IndexersSettingsComponent);
  fixture.detectChanges();
  http.expectOne({ url: '/api/indexers', method: 'GET' }).flush(rows);
  await settle(fixture);
  return { fixture, http };
}

describe('IndexersSettingsComponent — characterisation', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('lists the loaded indexers', async () => {
    const { fixture } = await createComponent();
    expect(fixture.nativeElement.textContent).toContain('MyTracker');
  });

  it('creates with trimmed name, stripped trailing slash on the base URL, and dropped blank api key', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.indexers.new'), fixture);

    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_name'), '  New Indexer  ');
    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_torznab_base_url'), 'http://prowlarr:9696/1/api/');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.indexers.save').click();

    const req = http.expectOne({ url: '/api/indexers', method: 'POST' });
    const body = req.request.body as Record<string, unknown>;
    expect(body['name']).toBe('New Indexer');
    expect((body['settings'] as Record<string, unknown>)['baseUrl']).toBe('http://prowlarr:9696/1/api');
    expect((body['settings'] as Record<string, unknown>)['apiKey']).toBeUndefined();
    req.flush({ ...ROW, id: 2, ...body });
    await settle(fixture);
    http.expectOne({ url: '/api/indexers', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('does not save without a base URL', async () => {
    const { fixture } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.indexers.new'), fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_name'), 'No URL');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.indexers.save').click();
    // http.verify() in afterEach fails if a POST was issued anyway.
  });

  it('populates the editor from an existing row and never re-sends the stored api key on save', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.indexers.edit'), fixture);
    expect(inputForLabel(fixture.nativeElement, 'settings.indexers.field_torznab_base_url').value).toBe(
      'http://prowlarr:9696/1/api',
    );
    expect(inputForLabel(fixture.nativeElement, 'settings.indexers.field_api_key').value).toBe('');

    buttonByText(fixture.nativeElement, 'settings.indexers.save').click();

    const req = http.expectOne({ url: '/api/indexers/1', method: 'PUT' });
    const putSettings = (req.request.body as Record<string, unknown>)['settings'] as Record<string, unknown>;
    expect(putSettings['apiKey']).toBeUndefined();
    req.flush(ROW);
    await settle(fixture);
    http.expectOne({ url: '/api/indexers', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('sends requestDelay and enableSearch as top-level fields, not nested under settings', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.indexers.new'), fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_name'), 'X');
    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_torznab_base_url'), 'http://x/api');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.indexers.save').click();

    const req = http.expectOne({ url: '/api/indexers', method: 'POST' });
    const body = req.request.body as Record<string, unknown>;
    expect(body['requestDelay']).toBe(2);
    expect(body['enableSearch']).toBe(true);
    expect((body['settings'] as Record<string, unknown>)['requestDelay']).toBeUndefined();
    req.flush({ ...ROW, id: 3 });
    await settle(fixture);
    http.expectOne({ url: '/api/indexers', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('tests the connection using the current draft values, not a saved row', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.indexers.new'), fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.indexers.field_torznab_base_url'), 'http://x/api/');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.indexers.test_connection').click();

    const req = http.expectOne({ url: '/api/indexers/test-connection', method: 'POST' });
    expect(req.request.body).toMatchObject({ implementation: 'torznab', settings: { baseUrl: 'http://x/api', apiKey: '' } });
    req.flush({ ok: true, message: 'Connected' });
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Connected');
  });

  it('deletes after confirmation and reloads', async () => {
    const { fixture, http } = await createComponent();
    buttonByText(fixture.nativeElement, 'settings.indexers.delete').click();
    await settle(fixture);

    http.expectOne({ url: '/api/indexers/1', method: 'DELETE' }).flush(null);
    await settle(fixture);
    http.expectOne({ url: '/api/indexers', method: 'GET' }).flush([]);
    await settle(fixture);
  });

  it('reports a cooled-down row and lifts it via the reset button', async () => {
    const cooled = {
      ...ROW,
      cooldown: { reason: 'rate-limit' as const, remainingMs: 60_000, until: new Date(Date.now() + 60_000).toISOString() },
    };
    const { fixture, http } = await createComponent([cooled]);

    expect(fixture.componentInstance.isCooledDown(cooled)).toBe(true);
    buttonByText(fixture.nativeElement, 'settings.indexers.cooldown_reset').click();
    http.expectOne({ url: '/api/indexers/1/cooldown', method: 'DELETE' }).flush({ cleared: true });
    await settle(fixture);
    http.expectOne({ url: '/api/indexers', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('fetches per-indexer stats', async () => {
    const { fixture, http } = await createComponent();
    buttonByText(fixture.nativeElement, 'settings.indexers.stats').click();
    http.expectOne({ url: '/api/indexers/1/stats', method: 'GET' }).flush([
      { date: '2026-08-01', queries: 3, avgResponseMs: 120, totalResults: 10, errors: 0 },
    ]);
    await settle(fixture);
    expect(fixture.componentInstance.statsData().length).toBe(1);
  });
});
