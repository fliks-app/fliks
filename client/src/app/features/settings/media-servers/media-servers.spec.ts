import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { MediaServersSettingsComponent } from './media-servers';
import {
  MediaServerRow,
  MediaServersApiService,
} from '../../../core/services/api/media-servers-api.service';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const row: MediaServerRow = {
  id: 1,
  name: 'Emby',
  type: 'emby',
  url: 'http://emby:8096',
  apiKey: '',
  apiKeySet: true,
  events: ['library.rescan'],
  enabled: true,
};

async function setup() {
  const api = {
    getTypes: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([row]),
    update: vi.fn().mockResolvedValue(row),
    create: vi.fn().mockResolvedValue(row),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: MediaServersApiService, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(MediaServersSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return { api, c: fixture.componentInstance };
}

describe('MediaServersSettingsComponent — redacted api key', () => {
  it('leaves the key out of an edit that did not type one', async () => {
    const { api, c } = await setup();
    c.openEdit(row);
    expect(c.formApiKey()).toBe('');
    await c.save();
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('apiKey');
  });

  it('sends a newly typed key, and the key of a create', async () => {
    const { api, c } = await setup();
    c.openEdit(row);
    c.formApiKey.set(' fresh ');
    await c.save();
    expect(api.update.mock.calls[0][1].apiKey).toBe('fresh');
    c.openCreate();
    c.formName.set('n');
    c.formUrl.set('http://u');
    await c.save();
    expect(api.create.mock.calls[0][0].apiKey).toBe('');
  });

  it('toggles without re-sending the key', async () => {
    const { api, c } = await setup();
    await c.toggleEnabled(row);
    expect(api.update.mock.calls[0][1]).not.toHaveProperty('apiKey');
    expect(api.update.mock.calls[0][1].enabled).toBe(false);
  });
});
