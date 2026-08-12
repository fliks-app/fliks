import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TranslateLoader, provideTranslateService } from '@ngx-translate/core';
import { of } from 'rxjs';
import { PluginsSettingsComponent } from './plugins';
import { ConfirmationService } from '../../../core/services/confirmation.service';
import type { PluginSummary } from '../../../core/services/api/plugins-api.service';

/** Drives the enable/disable toggle through its rendered DOM and the real HTTP wire. */

async function settle(fixture: ComponentFixture<unknown>) {
  await fixture.whenStable();
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
}

const ROW: PluginSummary = {
  pluginId: 'fliks.acme',
  name: 'Acme',
  version: '1.0.0',
  kind: 'data',
  origin: 'manual',
  status: 'active',
  statusReason: null,
  signature: 'unsigned',
  verifiedByKeyId: null,
  enabled: true,
};

async function createComponent(rows: PluginSummary[] = [ROW]) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideTranslateService({
        lang: 'en',
        loader: { provide: TranslateLoader, useValue: { getTranslation: () => of({}) } },
      }),
      { provide: ConfirmationService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(PluginsSettingsComponent);
  fixture.detectChanges();
  http.expectOne({ url: '/api/plugins', method: 'GET' }).flush(rows);
  http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([]);
  await settle(fixture);
  return { fixture, http };
}

function toggleInput(fixture: ComponentFixture<unknown>): HTMLInputElement {
  const input = (fixture.nativeElement as HTMLElement).querySelector('tbody input.toggle');
  if (!input) throw new Error('No row toggle found');
  return input as HTMLInputElement;
}

describe('PluginsSettingsComponent — enable/disable toggle', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('disabling calls POST .../disable and the row signal reflects the response', async () => {
    const { fixture, http } = await createComponent();
    expect(toggleInput(fixture).checked).toBe(true);

    toggleInput(fixture).click();
    await settle(fixture);

    const req = http.expectOne({ url: '/api/plugins/fliks.acme/disable', method: 'POST' });
    // The server disagrees with what the native click alone already shows, so only a
    // real read of this response — not the click's own DOM side effect — can pass.
    req.flush({ ...ROW, enabled: true, statusReason: 'server-said-so' });
    await settle(fixture);
    // Contributions are re-read so the nav and the settings sidebar follow the switch.
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);

    expect(fixture.componentInstance.rows()[0]).toEqual(expect.objectContaining({ enabled: true, statusReason: 'server-said-so' }));
  });

  it('enabling calls POST .../enable and the row signal reflects the response', async () => {
    const { fixture, http } = await createComponent([{ ...ROW, enabled: false }]);
    expect(toggleInput(fixture).checked).toBe(false);

    toggleInput(fixture).click();
    await settle(fixture);

    const req = http.expectOne({ url: '/api/plugins/fliks.acme/enable', method: 'POST' });
    req.flush({ ...ROW, enabled: false, statusReason: 'server-said-so' });
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);

    expect(fixture.componentInstance.rows()[0]).toEqual(expect.objectContaining({ enabled: false, statusReason: 'server-said-so' }));
  });

  it('VERDICT: uninstalling re-reads the contributions, so the sidebar loses the plugin at once', async () => {
    const { fixture, http } = await createComponent();

    void fixture.componentInstance.uninstall(ROW);
    await settle(fixture);
    http.expectOne({ url: '/api/plugins/fliks.acme', method: 'DELETE' }).flush({});
    await settle(fixture);
    http.expectOne({ url: '/api/plugins', method: 'GET' }).flush([]);
    http.expectOne({ url: '/api/plugins/sources', method: 'GET' }).flush([]);
    await settle(fixture);

    // Without this the pages stay linked in the admin sidebar until a full page load.
    http.expectOne({ url: '/api/plugins/ui', method: 'GET' }).flush([]);
    await settle(fixture);
  });

  it('VERDICT: a disabled plugin does not read as active in the status column', async () => {
    const { fixture } = await createComponent([{ ...ROW, enabled: false }]);

    const badges = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody .badge')).map(
      (b) => b.textContent?.trim(),
    );
    expect(badges).toContain('settings.plugins.status_disabled');
    expect(badges).not.toContain('settings.plugins.status_active');
  });

  it('a plugin that is on but not answering reads as unavailable, not active', async () => {
    const { fixture } = await createComponent([{ ...ROW, kind: 'process', processState: 'backoff' }]);

    const badges = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('tbody .badge')).map(
      (b) => b.textContent?.trim(),
    );
    expect(badges).toContain('settings.plugins.status_unavailable');
    expect(badges).not.toContain('settings.plugins.status_active');
  });
});
