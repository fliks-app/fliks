import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { DownloadClientsSettingsComponent } from './download-clients';
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

/** A signal write inside a native click handler needs one extra microtask before zoneless CD reflects it. */
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
  name: 'Home qBit',
  implementation: 'qbittorrent',
  settings: { host: '192.168.1.5', port: 8090, username: 'admin', useSsl: false, category: 'fliks' },
  priority: 1,
  enabled: true,
};

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
  const fixture = TestBed.createComponent(DownloadClientsSettingsComponent);
  fixture.detectChanges();
  http.expectOne({ url: '/api/download-clients', method: 'GET' }).flush([ROW]);
  await settle(fixture);
  return { fixture, http };
}

describe('DownloadClientsSettingsComponent — characterisation', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('lists the loaded clients', async () => {
    const { fixture } = await createComponent();
    expect(fixture.nativeElement.textContent).toContain('Home qBit');
  });

  it('creates with defaults and drops an untouched password', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.download_clients.new'), fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.download_clients.field_name'), '  New Client  ');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.download_clients.save').click();

    const req = http.expectOne({ url: '/api/download-clients', method: 'POST' });
    const body = req.request.body as { name: string; settings: Record<string, unknown>; priority: number; enabled: boolean };
    expect(body.name).toBe('New Client');
    expect(body.settings['host']).toBe('localhost');
    expect(body.settings['port']).toBe(8080);
    expect(body.settings['password']).toBeUndefined();
    expect(body.priority).toBe(1);
    expect(body.enabled).toBe(true);
    req.flush({ ...ROW, id: 2, ...body });
    await settle(fixture);
    http.expectOne({ url: '/api/download-clients', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('does not save without a name', async () => {
    const { fixture } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.download_clients.new'), fixture);
    buttonByText(fixture.nativeElement, 'settings.download_clients.save').click();
    // http.verify() in afterEach fails if a POST was issued anyway.
  });

  it('populates the editor from an existing row and never re-sends the stored password on save', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.download_clients.edit'), fixture);
    expect(inputForLabel(fixture.nativeElement, 'settings.download_clients.field_host').value).toBe('192.168.1.5');
    expect(inputForLabel(fixture.nativeElement, 'settings.download_clients.field_password').value).toBe('');

    buttonByText(fixture.nativeElement, 'settings.download_clients.save').click();

    const req = http.expectOne({ url: '/api/download-clients/1', method: 'PUT' });
    const body = req.request.body as { settings: Record<string, unknown> };
    expect(body.settings['password']).toBeUndefined();
    expect(body.settings['username']).toBe('admin');
    req.flush(ROW);
    await settle(fixture);
    http.expectOne({ url: '/api/download-clients', method: 'GET' }).flush([ROW]);
    await settle(fixture);
  });

  it('tests the connection using the current draft, not a saved row', async () => {
    const { fixture, http } = await createComponent();
    await clickAndSettle(buttonByText(fixture.nativeElement, 'settings.download_clients.new'), fixture);
    typeInto(inputForLabel(fixture.nativeElement, 'settings.download_clients.field_host'), '10.0.0.9');
    fixture.detectChanges();
    buttonByText(fixture.nativeElement, 'settings.download_clients.test_connection').click();

    const req = http.expectOne({ url: '/api/download-clients/test-connection', method: 'POST' });
    const body = req.request.body as { settings: Record<string, unknown> };
    expect(body.settings['host']).toBe('10.0.0.9');
    req.flush({ ok: true, message: 'Connected' });
    await settle(fixture);
    expect(fixture.nativeElement.textContent).toContain('Connected');
  });

  it('deletes after confirmation and reloads', async () => {
    const { fixture, http } = await createComponent();
    buttonByText(fixture.nativeElement, 'settings.download_clients.delete').click();
    await settle(fixture);

    http.expectOne({ url: '/api/download-clients/1', method: 'DELETE' }).flush(null);
    await settle(fixture);
    http.expectOne({ url: '/api/download-clients', method: 'GET' }).flush([]);
    await settle(fixture);
  });
});
