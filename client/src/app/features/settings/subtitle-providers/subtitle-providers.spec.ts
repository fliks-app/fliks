import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { SubtitleProvidersSettingsComponent } from './subtitle-providers';
import { SubtitleProvidersApiService } from '../../../core/services/api/subtitle-providers-api.service';
import { TranslationProvidersApiService } from '../../../core/services/api/translation-providers-api.service';
import { SettingsApiService } from '../../../core/services/api/settings-api.service';

// jsdom does not implement <dialog> — the component only needs it not to throw.
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

const TRANSLATIONS = {
  settings: {
    subtitle_providers: {
      field_username: 'Username',
      field_password: 'Password',
      field_api_key: 'API Key',
    },
  },
};

/** Finds the <input> inside the <label> whose visible text matches, by walking
 *  the rendered DOM — stable whether the field markup is hand-rolled or comes
 *  from <app-schema-form>, as long as the label text stays the same. */
function inputForLabel(root: HTMLElement, labelText: string): HTMLInputElement {
  const labels = Array.from(root.querySelectorAll('label'));
  const label = labels.find((l) => l.querySelector('.label-text')?.textContent?.trim() === labelText);
  const input = label?.querySelector('input');
  if (!input) throw new Error(`No input found for label "${labelText}"`);
  return input as HTMLInputElement;
}

function typeInto(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function createComponent() {
  const create = vi.fn((body: unknown) =>
    Promise.resolve({ id: 1, name: '', type: '', enabled: true, priority: 1, settings: {}, ...(body as object) }),
  );
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of(TRANSLATIONS) } },
      }),
      {
        provide: SubtitleProvidersApiService,
        useValue: { list: () => Promise.resolve([]), getRateLimits: () => Promise.resolve([]), create },
      },
      { provide: TranslationProvidersApiService, useValue: { list: () => Promise.resolve([]) } },
      { provide: SettingsApiService, useValue: { getAll: () => Promise.resolve({}) } },
    ],
  });
  const fixture = TestBed.createComponent(SubtitleProvidersSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, create };
}

describe('SubtitleProvidersSettingsComponent — provider editor settings payload', () => {
  it('sends trimmed username + password for opensubtitles, the default type', async () => {
    const { fixture, create } = await createComponent();
    fixture.componentInstance.openCreate();
    fixture.detectChanges();

    typeInto(inputForLabel(fixture.nativeElement, 'Username'), '  bob  ');
    typeInto(inputForLabel(fixture.nativeElement, 'Password'), '  secret  ');

    await fixture.componentInstance.save();

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      type: 'opensubtitles',
      settings: { username: 'bob', password: 'secret' },
    });
  });

  it('sends only apiKey for subdl, dropping the opensubtitles fields entered before the switch', async () => {
    const { fixture, create } = await createComponent();
    fixture.componentInstance.openCreate();
    fixture.detectChanges();

    typeInto(inputForLabel(fixture.nativeElement, 'Username'), 'bob');
    typeInto(inputForLabel(fixture.nativeElement, 'Password'), 'secret');

    fixture.componentInstance.onTypeChange('subdl');
    fixture.detectChanges();
    typeInto(inputForLabel(fixture.nativeElement, 'API Key'), 'sdl-key');

    await fixture.componentInstance.save();

    expect(create.mock.calls[0][0]).toMatchObject({
      type: 'subdl',
      settings: { apiKey: 'sdl-key' },
    });
    expect(create.mock.calls[0][0]).not.toHaveProperty('settings.username');
    expect(create.mock.calls[0][0]).not.toHaveProperty('settings.password');
  });

  it('sends an empty settings object for a type with no fields', async () => {
    const { fixture, create } = await createComponent();
    fixture.componentInstance.openCreate();
    fixture.componentInstance.onTypeChange('yify');
    fixture.detectChanges();

    await fixture.componentInstance.save();

    expect(create.mock.calls[0][0]).toMatchObject({ type: 'yify', settings: {} });
  });

  it('sends an untouched field as "", matching an untouched signal default', async () => {
    const { fixture, create } = await createComponent();
    fixture.componentInstance.openCreate();
    fixture.detectChanges();

    // Only the username is filled; password is left blank on purpose.
    typeInto(inputForLabel(fixture.nativeElement, 'Username'), 'bob');

    await fixture.componentInstance.save();

    expect(create.mock.calls[0][0]).toMatchObject({
      settings: { username: 'bob', password: '' },
    });
  });
});
