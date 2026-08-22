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

async function createComponent(events: string[] = []) {
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
        useValue: {
          get: (url: string) => of(url.endsWith('/events') ? events : []),
        } as unknown as HttpClient,
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
      token: 'tok',
    });

    c.formType.set('gotify');
    expect(settingsOf(c)).toEqual({
      url: 'https://ntfy.example.com',
      token: 'tok',
    });

    c.formType.set('webhook');
    expect(settingsOf(c)).toEqual({
      url: 'https://ntfy.example.com',
      token: 'tok',
    });
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

describe('NotificationsSettingsComponent — event vocabulary', () => {
  it('lists what the API advertises rather than a hardcoded set', async () => {
    const c = await createComponent(['request.created', 'subtitle.downloaded']);
    expect(c.allEvents()).toEqual(['request.created', 'subtitle.downloaded']);
  });

  it('pre-checks every advertised event on a new connection', async () => {
    const c = await createComponent(['request.created', 'subtitle.downloaded']);
    c.openCreate();
    expect(c.formEvents()).toEqual(['request.created', 'subtitle.downloaded']);
  });
});

describe('NotificationsSettingsComponent — provider tokens', () => {
  it('offers a token only to the providers that can use one', async () => {
    const c = await createComponent();
    for (const type of ['webhook', 'gotify', 'ntfy'] as const) {
      c.formType.set(type);
      expect(c.supportsToken()).toBe(true);
    }
    for (const type of ['discord', 'slack'] as const) {
      c.formType.set(type);
      expect(c.supportsToken()).toBe(false);
    }
  });

  it('omits a blank token so a public topic stores no credential', async () => {
    const c = await createComponent();
    c.formWebhookUrl.set('https://ntfy.sh');
    c.formTopic.set('media');
    c.formToken.set('   ');
    c.formType.set('ntfy');

    expect(settingsOf(c)).toEqual({ url: 'https://ntfy.sh', topic: 'media' });
  });

  it('sends an explicit null once the stored token is erased, and only where erasing is allowed', async () => {
    const c = await createComponent();
    c.openEdit({
      id: 1,
      name: 'Ntfy',
      type: 'ntfy',
      enabled: true,
      events: [],
      settings: { url: 'https://ntfy.sh', topic: 'media', secretsSet: ['token'] },
    });
    expect(c.tokenStored()).toBe(true);
    expect(c.canClearToken()).toBe(true);

    c.formTokenCleared.set(true);
    expect(settingsOf(c)).toEqual({ url: 'https://ntfy.sh', topic: 'media', token: null });

    // gotify cannot send without one, so the affordance is not offered there.
    c.formType.set('gotify');
    expect(c.canClearToken()).toBe(false);
  });

  it('cancels a pending erase as soon as a replacement token is typed', async () => {
    const c = await createComponent();
    c.formType.set('ntfy');
    c.formWebhookUrl.set('https://ntfy.sh');
    c.formTopic.set('media');
    c.formTokenCleared.set(true);

    c.onTokenInput('fresh');

    expect(c.formTokenCleared()).toBe(false);
    expect(settingsOf(c)).toEqual({ url: 'https://ntfy.sh', topic: 'media', token: 'fresh' });
  });

  it('reports no stored token when the response lists none', async () => {
    const c = await createComponent();
    c.openEdit({
      id: 1,
      name: 'Ntfy',
      type: 'ntfy',
      enabled: true,
      events: [],
      settings: { url: 'https://ntfy.sh', secretsSet: [] },
    });
    expect(c.tokenStored()).toBe(false);
    expect(c.canClearToken()).toBe(false);
  });

  it('leaves the token blank on edit, so saving keeps the stored one', async () => {
    const c = await createComponent();
    c.openEdit({
      id: 1,
      name: 'Ntfy',
      type: 'ntfy',
      enabled: true,
      events: [],
      settings: { url: 'https://ntfy.example.com', topic: 'media' },
    });

    expect(c.formToken()).toBe('');
    expect(settingsOf(c)).not.toHaveProperty('token');
  });
});
