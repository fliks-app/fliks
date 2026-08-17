import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { NotificationsSettingsComponent } from './notifications';
import { ConfirmationService } from '../../../core/services/confirmation.service';

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

async function createComponent() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideTranslateService({
        lang: 'en',
        loader: {
          provide: TranslateLoader,
          useValue: { getTranslation: () => of({}) },
        },
      }),
      {
        provide: HttpClient,
        useValue: { get: () => of([]) } as unknown as HttpClient,
      },
      {
        provide: ConfirmationService,
        useValue: {
          confirm: () => Promise.resolve(true),
          alert: () => Promise.resolve(),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(NotificationsSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.componentInstance;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const settingsOf = (c: NotificationsSettingsComponent) =>
  (c as any).buildSettings() as Record<string, unknown>;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('NotificationsSettingsComponent — endpoint settings key', () => {
  it('sends the endpoint as url for the types that read url', async () => {
    const c = await createComponent();
    c.formWebhookUrl.set('https://ntfy.example.com');
    c.formTopic.set('media');
    c.formToken.set('tok');

    c.formType.set('ntfy');
    expect(settingsOf(c)).toEqual({
      url: 'https://ntfy.example.com',
      topic: 'media',
    });

    c.formType.set('gotify');
    expect(settingsOf(c)).toEqual({
      url: 'https://ntfy.example.com',
      token: 'tok',
    });

    c.formType.set('webhook');
    expect(settingsOf(c)).toEqual({ url: 'https://ntfy.example.com' });
  });

  it('keeps discord and slack on webhookUrl', async () => {
    const c = await createComponent();
    c.formWebhookUrl.set('https://discord.test/hook');
    for (const type of ['discord', 'slack'] as const) {
      c.formType.set(type);
      expect(settingsOf(c)).toEqual({ webhookUrl: 'https://discord.test/hook' });
    }
  });

  it('hydrates the editor instead of blanking it, so an edit keeps the endpoint', async () => {
    const c = await createComponent();
    c.openEdit({
      id: 1,
      name: 'Ntfy',
      type: 'ntfy',
      enabled: true,
      events: ['health.issue'],
      settings: { url: 'https://ntfy.example.com', topic: 'media' },
    });

    expect(c.formWebhookUrl()).toBe('https://ntfy.example.com');
    expect(c.formTopic()).toBe('media');
    // Renaming and saving must not wipe the endpoint.
    c.formName.set('Renamed');
    expect(settingsOf(c)).toEqual({
      url: 'https://ntfy.example.com',
      topic: 'media',
    });
  });

  it('hydrates a not-yet-migrated row stored under webhookUrl', async () => {
    const c = await createComponent();
    c.openEdit({
      id: 2,
      name: 'Legacy',
      type: 'ntfy',
      enabled: true,
      events: [],
      settings: { webhookUrl: 'https://legacy.example.com', topic: 'old' },
    });

    expect(c.formWebhookUrl()).toBe('https://legacy.example.com');
    expect(settingsOf(c)).toEqual({
      url: 'https://legacy.example.com',
      topic: 'old',
    });
  });
});
