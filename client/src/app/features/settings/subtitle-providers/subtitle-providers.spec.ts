import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { SubtitleProvidersSettingsComponent } from './subtitle-providers';
import { ConfirmationService } from '../../../core/services/confirmation.service';

/**
 * Drives the download-providers section through its rendered DOM and the
 * real HTTP wire, not internal component methods — the seam that survives
 * migrating that CRUD list off hand-rolled signals onto the shared
 * `providers` renderer. The AI-translation section is untouched by this
 * migration and is not exercised here.
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

function selectForLabel(root: HTMLElement, labelText: string): HTMLSelectElement {
  const labels = Array.from(root.querySelectorAll('label'));
  const label = labels.find((l) => l.querySelector('.label-text')?.textContent?.trim() === labelText);
  const select = label?.querySelector('select');
  if (!select) throw new Error(`No select found for label "${labelText}"`);
  return select as HTMLSelectElement;
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
 * Selects by position, not by option value/text: the pre-migration `<select
 * [ngValue]>` renders index-based option values (its change handler reads
 * `selectedIndex`), while the post-migration renderer renders plain string
 * values with a translated (untranslated-key, in this harness) label. Only
 * the declared provider order is guaranteed stable across both.
 */
function selectPosition(select: HTMLSelectElement, index: number) {
  select.selectedIndex = index;
  select.dispatchEvent(new Event('change'));
}

/** Index of each provider type in the declared order — opensubtitles, subdl, subsynchro, supersubtitles, yify, gestdown. */
const PROVIDER_TYPE_INDEX = { opensubtitles: 0, subdl: 1, subsynchro: 2, supersubtitles: 3, yify: 4, gestdown: 5 };

/** A signal write inside a native click/change handler needs one extra microtask before zoneless CD reflects it. */
async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

async function clickAndSettle(el: HTMLElement, fixture: ComponentFixture<unknown>) {
  el.click();
  await settle(fixture);
}

const ROW = { id: 1, name: 'OpenSubtitles', type: 'opensubtitles', enabled: true, priority: 25, settings: {} };

async function createComponent() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ConfirmationService, useValue: { confirm: () => Promise.resolve(true), alert: () => Promise.resolve() } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SubtitleProvidersSettingsComponent);
  fixture.detectChanges();
  http.expectOne({ url: '/api/subtitles/providers', method: 'GET' }).flush([]);
  http.expectOne({ url: '/api/settings', method: 'GET' }).flush({});
  http.expectOne({ url: '/api/subtitles/translation-providers', method: 'GET' }).flush([]);
  // Rate limits are fetched reactively off the provider list's own reload, one tick later.
  await new Promise((r) => setTimeout(r, 0));
  http.expectOne({ url: '/api/subtitles/providers/rate-limits', method: 'GET' }).flush([]);
  await settle(fixture);
  return { fixture, http };
}

/** `save()` reloads the provider list, which reactively re-fetches rate limits one tick later. */
async function flushReload(http: HttpTestingController, fixture: ComponentFixture<unknown>) {
  // Let the awaited create()/update() call resume and issue the reload's GET first.
  await new Promise((r) => setTimeout(r, 0));
  http.expectOne({ url: '/api/subtitles/providers', method: 'GET' }).flush([]);
  await new Promise((r) => setTimeout(r, 0));
  http.expectOne({ url: '/api/subtitles/providers/rate-limits', method: 'GET' }).flush([]);
  await settle(fixture);
}

describe('SubtitleProvidersSettingsComponent — provider editor settings payload', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sends trimmed username + password for opensubtitles, the default type', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.subtitle_providers.new'), fixture);

    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_username'), '  bob  ');
    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_password'), '  secret  ');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.subtitle_providers.save').click();

    const req = http.expectOne({ url: '/api/subtitles/providers', method: 'POST' });
    expect(req.request.body).toMatchObject({ type: 'opensubtitles', settings: { username: 'bob', password: 'secret' } });
    req.flush({ ...ROW, id: 2 });
    await flushReload(http, fixture);
  });

  it('sends only apiKey for subdl, dropping the opensubtitles fields entered before the switch', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.subtitle_providers.new'), fixture);

    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_username'), 'bob');
    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_password'), 'secret');
    fixture.detectChanges();

    selectPosition(selectForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_type'), PROVIDER_TYPE_INDEX.subdl);
    await settle(fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_api_key'), 'sdl-key');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.subtitle_providers.save').click();

    const req = http.expectOne({ url: '/api/subtitles/providers', method: 'POST' });
    expect(req.request.body).toMatchObject({ type: 'subdl', settings: { apiKey: 'sdl-key' } });
    expect(req.request.body).not.toHaveProperty('settings.username');
    expect(req.request.body).not.toHaveProperty('settings.password');
    req.flush({ ...ROW, id: 3, type: 'subdl' });
    await flushReload(http, fixture);
  });

  it('sends an empty settings object for a type with no fields', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.subtitle_providers.new'), fixture);
    selectPosition(selectForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_type'), PROVIDER_TYPE_INDEX.yify);
    await settle(fixture);
    buttonByText(fixture.nativeElement, 'settings.subtitle_providers.save').click();

    const req = http.expectOne({ url: '/api/subtitles/providers', method: 'POST' });
    expect(req.request.body).toMatchObject({ type: 'yify', settings: {} });
    req.flush({ ...ROW, id: 4, type: 'yify' });
    await flushReload(http, fixture);
  });

  it('sends an untouched field as "", matching an untouched signal default', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.subtitle_providers.new'), fixture);

    // Only the username is filled; password is left blank on purpose.
    typeInto(inputForLabel(fixture.nativeElement, 'settings.subtitle_providers.field_username'), 'bob');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.subtitle_providers.save').click();

    const req = http.expectOne({ url: '/api/subtitles/providers', method: 'POST' });
    expect(req.request.body).toMatchObject({ settings: { username: 'bob', password: '' } });
    req.flush({ ...ROW, id: 5 });
    await flushReload(http, fixture);
  });
});
